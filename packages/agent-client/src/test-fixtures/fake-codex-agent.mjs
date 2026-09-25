// A stand-in for codex-acp 1.13.1, reduced to the contract the Codex
// integration depends on (read from its source: CodexAuthMethod.ts,
// CodexAcpServer.ts ensureAuthenticated and authenticate, CodexAcpClient.ts
// MCP mapping and device-code login; the stored-login rules measured against a
// real 1.13.1 with a temporary CODEX_HOME):
//  - initialize advertises `api-key` and `gateway` auth, `chat-gpt-device-code`
//    only to a client that declared URL elicitations, and
//    `mcpCapabilities {http: true, sse: false}`;
//  - session/new refuses with authRequired until `authenticate` succeeded or
//    a login was stored in CODEX_HOME (auth.json) — read once at start, as
//    the real process does: one that refused keeps refusing after another
//    process stores a login;
//  - `chat-gpt-device-code` asks the client to show a verification URL and a
//    code (URL elicitation), and on acceptance stores the login as
//    <CODEX_HOME>/auth.json and returns; a declined elicitation fails it;
//  - session/new refuses the whole request over a single `sse` MCP server.
// Deliberately careless with the key, the way a real harness may be: it prints
// it to stderr at start and echoes the Authorization header in a rejection —
// the client must keep both out of every log, error and event.
//
// In 'steering' mode it also plays codex-acp's steering contract
// (CodexAcpServer.ts executeOrQueueSteeringRequest and what it calls,
// CodexEventHandler.ts for the updates):
//  - initialize advertises `_meta.steering.supported`;
//  - `_session/steering` is serialised, ignores `idleBehavior`, answers
//    `injected` into a live turn, and otherwise waits for the previous prompt
//    to finish, starts a turn of its own and answers `startedNewTurn` the
//    moment that turn starts — the turn then runs on with nobody's prompt
//    response to end it;
//  - every turn reports `_meta.codex.threadStatus` active, then idle (or
//    systemError), and stamps its message chunks with the item id;
//  - a failed turn publishes its typed failure as a session info update.
// A turn runs until the test ends it through `_fake/finish`; `_fake/steer_mode`
// makes the next steers answer `failed`, throw, or arrive too late for the
// live turn ('late': the injection loses the race with the turn's end), and
// `_fake/exit` kills the process mid-turn.
//
// FAKE_AGENT_LOG: file that receives one JSON line per request.
// FAKE_AGENT_MODE: '' | 'reject-auth' | 'no-gateway' | 'open' (no auth needed)
//   | 'no-device-code' (never offers it) | 'device-code-fails' (the sign-in
//   is accepted and then fails, as an expired code does) | 'device-code-pending'
//   (the user never finishes it) | 'steering'.
// FAKE_DEVICE_URL / FAKE_DEVICE_CODE: the verification page and one-time code
//   the device-code sign-in shows (a real agent gets them from the provider).
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'

const mode = process.env.FAKE_AGENT_MODE ?? ''
const log = (entry) => {
  if (process.env.FAKE_AGENT_LOG) {
    // The pid tells one process's requests from the next one's.
    appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ ...entry, pid: process.pid })}\n`)
  }
}
process.stderr.write(`fake codex-acp starting, CODEX_API_KEY=${process.env.CODEX_API_KEY ?? ''}\n`)

const authFile = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'auth.json') : null
let authenticated = mode === 'open' || (authFile !== null && existsSync(authFile))
let sessions = 0

const threadStatus = (type) => ({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type } } } })
const textOf = (prompt) => prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')

let steerMode = 'normal'
let turns = 0
let live = null
let lastPrompt = Promise.resolve()
let steers = Promise.resolve()

// One turn, from start to its (test-chosen) end. `onTurnStarted` is where
// codex-acp answers a steer that started this turn.
async function runTurn(agent, sessionId, text, onTurnStarted) {
  let completed = () => {}
  const completion = new Promise((resolve) => {
    completed = resolve
  })
  lastPrompt = completion
  turns += 1
  const itemId = `item-${turns}`
  let finish = () => {}
  const finished = new Promise((resolve) => {
    finish = resolve
  })
  live = { finish }
  await agent.sessionUpdate({ sessionId, update: threadStatus('active') })
  onTurnStarted?.()
  await agent.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `reply to ${text}` },
      messageId: itemId,
    },
  })
  const end = await finished
  live = null
  if (end.fail) {
    await agent.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          jetbrains: {
            air: {
              sessionFailure: {
                id: `failure-${turns}`,
                title: 'Provider failed',
                category: 'provider',
                severity: 'error',
              },
            },
          },
        },
      },
    })
  }
  await agent.sessionUpdate({ sessionId, update: threadStatus(end.systemError ? 'systemError' : 'idle') })
  completed()
  return { stopReason: end.cancelled ? 'cancelled' : 'end_turn' }
}

async function steer(connection, params) {
  if (steerMode === 'throw') {
    throw RequestError.internalError(undefined, 'steering exploded')
  }
  if (steerMode === 'failed') {
    return { outcome: 'failed' }
  }
  if (live && steerMode !== 'late') {
    return { outcome: 'injected' }
  }
  await lastPrompt
  return new Promise((resolve) => {
    void runTurn(connection, params.sessionId, textOf(params.prompt), () => resolve({ outcome: 'startedNewTurn' }))
  })
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(
  (connection) => ({
    async initialize(params) {
      log({
        method: 'initialize',
        params,
        cwd: process.cwd(),
        env: {
          CODEX_HOME: process.env.CODEX_HOME ?? null,
          CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,
          NO_BROWSER: process.env.NO_BROWSER ?? null,
        },
      })
      const authMethods = [{ id: 'api-key', name: 'API Key' }]
      if (params.clientCapabilities?.elicitation?.url && mode !== 'no-device-code') {
        authMethods.push({ id: 'chat-gpt-device-code', name: 'ChatGPT (device code)' })
      }
      if (mode !== 'no-gateway') {
        authMethods.push({ id: 'gateway', name: 'Custom model gateway' })
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
          mcpCapabilities: { http: true, sse: false },
        },
        authMethods,
        ...(mode === 'steering' ? { _meta: { steering: { supported: true } } } : {}),
      }
    },
    async authenticate(params) {
      log({ method: 'authenticate', params })
      if (params.methodId === 'chat-gpt-device-code') {
        const elicitationId = 'fake-login'
        const response = await connection.createElicitation({
          mode: 'url',
          requestId: 0,
          elicitationId,
          url: process.env.FAKE_DEVICE_URL ?? '',
          message: `Sign in to ChatGPT and enter this code: ${process.env.FAKE_DEVICE_CODE ?? ''}`,
        })
        log({ method: 'elicitation/response', params: response })
        if (mode === 'device-code-pending') {
          await new Promise(() => {})
        }
        if (response.action !== 'accept' || mode === 'device-code-fails' || !authFile) {
          throw RequestError.invalidParams()
        }
        writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'made-up' } }))
        await connection.completeElicitation({ elicitationId })
        authenticated = true
        return {}
      }
      if (mode === 'reject-auth') {
        throw RequestError.invalidParams(
          { header: params._meta?.gateway?.headers?.Authorization },
          `gateway rejected credentials ${params._meta?.gateway?.headers?.Authorization}`,
        )
      }
      // 'auth-lost': the sign-in is accepted and does not hold, so every
      // process refuses its sessions however often it is signed in.
      authenticated = mode !== 'auth-lost'
      return {}
    },
    async newSession(params) {
      log({ method: 'session/new', params })
      if (!authenticated) {
        throw RequestError.authRequired()
      }
      if (params.mcpServers.some((server) => server.type === 'sse')) {
        throw RequestError.invalidRequest(undefined, 'SSE MCP servers are not supported')
      }
      sessions += 1
      return { sessionId: `fake-${process.pid}-${sessions}` }
    },
    // Load, resume and fork (codex-acp's getOrCreateSessionWithHistory and
    // tryCreateSession) sit behind the same sign-in check as session/new. The
    // fake keeps no transcripts, so any id is taken back.
    async loadSession(params) {
      log({ method: 'session/load', params })
      if (!authenticated) {
        throw RequestError.authRequired()
      }
      return {}
    },
    async resumeSession(params) {
      log({ method: 'session/resume', params })
      if (!authenticated) {
        throw RequestError.authRequired()
      }
      return {}
    },
    async closeSession(params) {
      log({ method: 'session/close', params })
      return {}
    },
    // `/logout` signs the whole process out and the turn itself succeeds.
    // codex-acp's command does that to an account login; a gateway sign-in
    // survives it there (measured on 1.13.1: session/new, load, resume and
    // fork are all still accepted afterwards), so this is the stricter harness
    // the engine has to cope with. Nothing else a prompt says matters here.
    async prompt(params) {
      const text = params.prompt[0]?.type === 'text' ? params.prompt[0].text.trim() : ''
      log({ method: 'session/prompt', params })
      if (text === '/logout') {
        authenticated = false
      }
      if (mode !== 'steering') {
        return { stopReason: 'end_turn' }
      }
      return runTurn(connection, params.sessionId, textOf(params.prompt))
    },
    async cancel() {
      live?.finish({ cancelled: true })
    },
    async extMethod(method, params) {
      log({ method, params })
      if (method === '_session/steering') {
        const answer = steers.then(() => steer(connection, params))
        steers = answer.catch(() => {})
        return answer
      }
      if (method === '_fake/finish') {
        live?.finish(params)
        return {}
      }
      if (method === '_fake/exit') {
        // Dies mid-turn, the way a crashed harness does: no idle status, no
        // answer to anything still open.
        setTimeout(() => process.exit(1), 10)
        return {}
      }
      if (method === '_fake/steer_mode') {
        steerMode = params.mode
        return {}
      }
      throw RequestError.methodNotFound(method)
    },
  }),
  stream,
)
