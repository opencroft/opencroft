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
// FAKE_AGENT_LOG: file that receives one JSON line per request.
// FAKE_AGENT_MODE: '' | 'reject-auth' | 'no-gateway' | 'open' (no auth needed)
//   | 'no-device-code' (never offers it) | 'device-code-fails' (the sign-in
//   is accepted and then fails, as an expired code does) | 'device-code-pending'
//   (the user never finishes it).
// FAKE_DEVICE_URL / FAKE_DEVICE_CODE: the verification page and one-time code
//   the device-code sign-in shows (a real agent gets them from the provider).
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'

const mode = process.env.FAKE_AGENT_MODE ?? ''
const log = (entry) => {
  if (process.env.FAKE_AGENT_LOG) {
    appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify(entry)}\n`)
  }
}
process.stderr.write(`fake codex-acp starting, CODEX_API_KEY=${process.env.CODEX_API_KEY ?? ''}\n`)

const authFile = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'auth.json') : null
let authenticated = mode === 'open' || (authFile !== null && existsSync(authFile))
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
        agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false } },
        authMethods,
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
      authenticated = true
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
      return { sessionId: `fake-${process.pid}` }
    },
    async prompt() {
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
  }),
  stream,
)
