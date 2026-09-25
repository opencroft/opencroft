// A stand-in for claude-agent-acp 0.81.2, reduced to what a fork depends on.
// Read from its dist (fork-session.js, session-model.js, session-mode.js and
// acp-agent.js); the same fork and prompt code is in 0.78.0 and 0.79.0:
//  - initialize advertises `sessionCapabilities` fork, resume and close;
//  - a session is live only once session/new or session/resume has built it
//    (acp-agent.js getOrCreateSession). The transcript on disk is a separate
//    thing, and is what resume and fork read;
//  - session/fork writes a new transcript and answers with its id and nothing
//    else (fork-session.js forkSession). No live session is built, the MCP
//    servers in the request are not used, and no modes or config options come
//    back;
//  - session/prompt, set_config_option and set_mode on a session that is not
//    live throw a plain `Error("Session not found")` (acp-agent.js prompt and
//    setSessionConfigOption, session-mode.js requireOpenSession). The ACP SDK
//    answers a plain throw with -32603 "Internal error" and puts the thrown
//    message in `data.details`, so the cause never reaches the message;
//  - session/resume builds the session on the model ANTHROPIC_MODEL names,
//    whatever the transcript last ran on (session-model.js getAvailableModels
//    re-asserts it on every resumed session).
//
// FAKE_AGENT_LOG: file that receives one JSON line per request.
// FAKE_AGENT_MODE: '' | 'prompt-leaks-key' (every prompt is refused with the
//   key in the refusal's data, the way a provider error can quote a header)
//   | 'fork-unresumable' (a fork's transcript cannot be read back).
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'

const mode = process.env.FAKE_AGENT_MODE ?? ''
const log = (entry) => {
  if (process.env.FAKE_AGENT_LOG) {
    appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ ...entry, pid: process.pid })}\n`)
  }
}

const envModel = process.env.ANTHROPIC_MODEL || 'default'
const MODES = [
  { id: 'default', name: 'Default' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'plan', name: 'Plan Mode' },
]
const MODELS = [...new Set(['default', envModel, 'claude-sonnet-5'])]

// Transcripts by session id: what the process would find on disk.
const transcripts = new Map()
// Live sessions by id: the bridge's `this.sessions`.
const live = new Map()
const forks = new Set()
let minted = 0

function stateOf(session) {
  return {
    modes: { currentModeId: session.mode, availableModes: MODES },
    configOptions: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: session.mode,
        options: MODES.map((entry) => ({ value: entry.id, name: entry.name })),
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: session.model,
        options: MODELS.map((value) => ({ value, name: value })),
      },
    ],
  }
}

function openSession(sessionId) {
  const session = live.get(sessionId)
  if (!session) {
    throw new Error('Session not found')
  }
  return session
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(
  () => ({
    async initialize(params) {
      log({ method: 'initialize', params })
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {}, fork: {}, resume: {} },
          promptCapabilities: { image: true },
        },
        authMethods: [],
      }
    },
    async newSession(params) {
      log({ method: 'session/new', params })
      minted += 1
      const sessionId = `claude-${process.pid}-${minted}`
      transcripts.set(sessionId, { turns: 0 })
      const session = { mode: 'default', model: envModel }
      live.set(sessionId, session)
      return { sessionId, ...stateOf(session) }
    },
    async unstable_forkSession(params) {
      log({ method: 'session/fork', params })
      const source = transcripts.get(params.sessionId)
      if (!source) {
        throw RequestError.resourceNotFound(params.sessionId)
      }
      minted += 1
      const sessionId = `claude-${process.pid}-${minted}`
      transcripts.set(sessionId, { ...source })
      forks.add(sessionId)
      return { sessionId }
    },
    async resumeSession(params) {
      log({ method: 'session/resume', params })
      if (!transcripts.has(params.sessionId)) {
        throw RequestError.resourceNotFound(params.sessionId)
      }
      if (mode === 'fork-unresumable' && forks.has(params.sessionId)) {
        throw new Error('transcript unreadable')
      }
      const session = live.get(params.sessionId) ?? { mode: 'default', model: envModel }
      live.set(params.sessionId, session)
      return stateOf(session)
    },
    async closeSession(params) {
      log({ method: 'session/close', params })
      openSession(params.sessionId)
      live.delete(params.sessionId)
      return {}
    },
    async setSessionMode(params) {
      log({ method: 'session/set_mode', params })
      openSession(params.sessionId).mode = params.modeId
      return {}
    },
    async setSessionConfigOption(params) {
      log({ method: 'session/set_config_option', params })
      const session = openSession(params.sessionId)
      if (params.configId === 'model') {
        session.model = params.value
      } else if (params.configId === 'mode') {
        session.mode = params.value
      }
      return { configOptions: stateOf(session).configOptions }
    },
    async prompt(params) {
      log({ method: 'session/prompt', params })
      if (mode === 'prompt-leaks-key') {
        throw RequestError.internalError({
          details: `provider refused Authorization: Bearer ${process.env.ANTHROPIC_AUTH_TOKEN ?? ''}`,
        })
      }
      openSession(params.sessionId)
      const transcript = transcripts.get(params.sessionId)
      if (transcript) {
        transcript.turns += 1
      }
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
  }),
  stream,
)
