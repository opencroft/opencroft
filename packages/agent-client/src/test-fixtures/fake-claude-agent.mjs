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
//    re-asserts it on every resumed session);
//  - after answering a resume the bridge keeps talking: on a zero timer it
//    sends available_commands_update (acp-agent.js resumeSession), and the
//    SDK's first messages on the new query make it announce its config with a
//    config_option_update (syncFastModeState). Both carry the state the
//    session opened on, and both can land after the answer but before the
//    client's first set_config_option comes back.
//
// FAKE_AGENT_LOG: file that receives one JSON line per request.
// FAKE_AGENT_MODE: '' | 'prompt-leaks-key' (every prompt is refused with the
//   key in the refusal's data, the way a provider error can quote a header)
//   | 'fork-unresumable' (a fork's transcript cannot be read back)
//   | 'prompt-sends-notices' (every prompt reports one notice of each defined
//   severity before it ends, the way the bridge's session-notices.js does in
//   0.84.0: as `notice` updates only when initialize advertised
//   `clientCapabilities.session.notices` as an object, otherwise as a
//   bold-label agent_message_chunk)
//   | 'prompt-drops-connection' (a prompt whose text is "drop the connection"
//   is never answered: the fake closes its end of the connection instead, the
//   way the SDK closes it on a line over its size limit).
// FAKE_AGENT_STATE: file the transcripts are kept in, so that a second process
//   finds the sessions the first one wrote — the bridge keeps them on disk.
//
// Like the bridge (index.js), the process exits once its connection closes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const statePath = process.env.FAKE_AGENT_STATE
const transcripts = new Map(statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [])
const saveTranscripts = () => {
  if (statePath) {
    writeFileSync(statePath, JSON.stringify([...transcripts]))
  }
}
// Live sessions by id: the bridge's `this.sessions`.
const live = new Map()
const forks = new Set()
let minted = 0
// The bridge's clientSupportsNotices, applied to what initialize received.
let supportsNotices = false

const NOTICES = [
  { severity: 'info', title: 'Task stopped by user', description: 'npm run dev.' },
  { severity: 'warning', title: 'Model fallback', description: 'Switched to a smaller model.' },
  { severity: 'error', title: 'Hook blocked the turn' },
]

function noticeOrTranscriptUpdate(notice) {
  if (supportsNotices) {
    return { sessionUpdate: 'notice', ...notice }
  }
  const text = notice.description ? `**${notice.title}:** ${notice.description}` : `**${notice.title}**`
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

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
const connection = new AgentSideConnection(
  (client) => ({
    async initialize(params) {
      log({ method: 'initialize', params })
      const notices = params.clientCapabilities?.session?.notices
      supportsNotices = typeof notices === 'object' && notices !== null && !Array.isArray(notices)
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
      saveTranscripts()
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
      saveTranscripts()
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
      // Announced once the answer is out, with the state as it stands then —
      // which is still the opening state, since the client's first
      // set_config_option has not been read yet.
      setTimeout(() => {
        void client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
        })
        void client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: stateOf(session).configOptions },
        })
      }, 0)
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
        // A model switch is a round trip to the CLI (query.setModel), measured
        // at 1.2 to 1.8 s in practice; the announcements above go out meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 50))
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
      if (mode === 'prompt-drops-connection' && params.prompt[0]?.text === 'drop the connection') {
        process.stdout.end()
        return new Promise(() => {})
      }
      const transcript = transcripts.get(params.sessionId)
      if (transcript) {
        transcript.turns += 1
        saveTranscripts()
      }
      if (mode === 'prompt-sends-notices') {
        for (const notice of NOTICES) {
          await client.sessionUpdate({ sessionId: params.sessionId, update: noticeOrTranscriptUpdate(notice) })
        }
      }
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
  }),
  stream,
)
connection.closed.then(() => process.exit(0))
