// A stand-in for the Copilot CLI 1.0.95 in `--acp` mode, reduced to the
// contract the Copilot adapters depend on (measured against the real 1.0.95
// with a temporary COPILOT_HOME):
//  - initialize advertises `loadSession`, `mcpCapabilities {http: true, sse:
//    true}`, `sessionCapabilities {close, list}` and one `copilot-login`
//    terminal auth method, which an ACP client cannot run;
//  - session/new needs no `authenticate`: it opens on the profile's own
//    provider (COPILOT_PROVIDER_BASE_URL), else on the first GitHub token of
//    COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN, else refuses with
//    authRequired. The real CLI then also tries a login stored in its home and
//    `gh auth token`; the fake has neither, so a test sees exactly what the
//    spawn's environment offers;
//  - session/new answers the `mode` and `allow_all` config options, and takes
//    MCP servers of every transport;
//  - right after session/new, `available_commands_update` with the 33
//    commands 1.0.95 advertises, under its names;
//  - three modes named by URL, starting in `agent` with `allow_all` off.
//    Entering `autopilot` turns `allow_all` on and leaving it turns it off;
//    set_mode and set_config_option for the mode report `current_mode_update`
//    when the mode changes and `config_option_update` either way;
//  - the prompt `/autopilot on` enters autopilot and `/autopilot off` returns
//    to `agent`, each answering one line of agent text. After the turn's
//    answer they report `current_mode_update`, then `config_option_update`
//    only when `allow_all` changed with the mode. Sent in the mode it is
//    already in, either answers `Already in … mode.` and reports nothing, and
//    `allow_all` stays as it was;
//  - with `allow_all` off, an MCP tool call is announced as `<server>-<tool>`
//    (kind `other`) and then asked about under the bare tool name, with the
//    options `allow_once`, `allow_always` and `reject_once`. Allow runs it,
//    anything else fails it, and the turn ends `end_turn` either way; a turn
//    cancelled while it asks ends `cancelled`.
// A prompt whose text contains `call app_call` makes that call to the `local`
// server's `app_call`.
// Deliberately careless with the credential, the way a real harness may be: it
// prints it to stderr at start — the client must keep it out of every log,
// error and event.
//
// FAKE_AGENT_LOG: file that receives one JSON line per request, with the
//   COPILOT_*, GH_* and GITHUB_* variables the process was started with.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'

const log = (entry) => {
  if (process.env.FAKE_AGENT_LOG) {
    appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ ...entry, pid: process.pid })}\n`)
  }
}
const copilotEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(COPILOT_|GH_|GITHUB_)/.test(name)))
const githubToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
process.stderr.write(
  `fake copilot starting, key=${process.env.COPILOT_PROVIDER_API_KEY ?? ''} token=${githubToken ?? ''}\n`,
)

const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#'
const MODES = [
  { id: `${MODE_URL}agent`, name: 'Agent', description: 'Default agent mode for conversational interactions' },
  { id: `${MODE_URL}plan`, name: 'Plan', description: 'Plan mode for creating and executing multi-step plans' },
  {
    id: `${MODE_URL}autopilot`,
    name: 'Autopilot',
    description:
      'Autonomous mode that enables allow-all and runs until task completion without user interaction (experimental)',
  },
]
const AUTOPILOT = `${MODE_URL}autopilot`
const COMMANDS = [
  'add-dir',
  'allow-all',
  'permissions',
  'autopilot',
  'compact',
  'blame',
  'chronicle',
  'computer',
  'context',
  'cwd',
  'env',
  'every',
  'after',
  'fleet',
  'init',
  'list-dirs',
  'mcp',
  'memory',
  'model',
  'plan',
  'plugin',
  'rename',
  'research',
  'remote',
  'reset-allowed-tools',
  'review',
  'sandbox',
  'security-review',
  'session',
  'share',
  'skills',
  'subconscious',
  'usage',
]
const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
]
let sessions = 0
// Per session: { mode, allowAll, cancelled }.
const state = new Map()

const configOptions = ({ mode, allowAll }) => [
  {
    type: 'select',
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: mode,
    options: MODES.map(({ id, name, description }) => ({ value: id, name, description })),
  },
  {
    type: 'select',
    id: 'allow_all',
    name: 'Allow All',
    category: 'permissions',
    currentValue: allowAll,
    options: [
      { value: 'on', name: 'On' },
      { value: 'off', name: 'Off' },
    ],
  },
]

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
let connection
// Moves the session to `modeId` and says which reports that calls for.
function enterMode(session, modeId) {
  const before = { mode: session.mode, allowAll: session.allowAll }
  if (modeId === AUTOPILOT && before.mode !== AUTOPILOT) {
    session.allowAll = 'on'
  } else if (modeId !== AUTOPILOT && before.mode === AUTOPILOT) {
    session.allowAll = 'off'
  }
  session.mode = modeId
  return { modeChanged: before.mode !== modeId, allowAllChanged: before.allowAll !== session.allowAll }
}
const reportMode = (sessionId, modeId) =>
  connection.sessionUpdate({ sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } })
const reportOptions = (sessionId) =>
  connection.sessionUpdate({
    sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions: configOptions(state.get(sessionId)) },
  })
async function switchMode(sessionId, modeId) {
  if (enterMode(state.get(sessionId), modeId).modeChanged) {
    await reportMode(sessionId, modeId)
  }
  await reportOptions(sessionId)
}
const SLASH_MODES = {
  '/autopilot on': { modeId: AUTOPILOT, name: 'autopilot' },
  '/autopilot off': { modeId: MODES[0].id, name: 'interactive' },
}
const say = (sessionId, text) =>
  connection.sessionUpdate({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })
connection = new AgentSideConnection(
  () => ({
    async initialize(params) {
      log({ method: 'initialize', params, cwd: process.cwd(), env: copilotEnv() })
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: true },
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { close: {}, list: {} },
        },
        agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.95' },
        authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }],
      }
    },
    async authenticate(params) {
      log({ method: 'authenticate', params })
      throw RequestError.invalidParams(undefined, 'copilot-login runs in a terminal')
    },
    async newSession(params) {
      log({ method: 'session/new', params })
      if (!process.env.COPILOT_PROVIDER_BASE_URL && !githubToken) {
        throw RequestError.authRequired()
      }
      sessions += 1
      const sessionId = `fake-${process.pid}-${sessions}`
      const session = { mode: MODES[0].id, allowAll: 'off', cancelled: false }
      state.set(sessionId, session)
      // After the answer, so the client already holds the session it is for.
      setImmediate(() => {
        void connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: COMMANDS.map((name) => ({ name, description: name })),
          },
        })
      })
      return {
        sessionId,
        modes: { availableModes: MODES, currentModeId: session.mode },
        configOptions: configOptions(session),
      }
    },
    async setSessionMode(params) {
      log({ method: 'session/set_mode', params })
      await switchMode(params.sessionId, params.modeId)
      return {}
    },
    async setSessionConfigOption(params) {
      log({ method: 'session/set_config_option', params })
      const session = state.get(params.sessionId)
      if (params.configId === 'mode') {
        await switchMode(params.sessionId, params.value)
      } else if (params.configId === 'allow_all') {
        session.allowAll = params.value
      }
      return { configOptions: configOptions(session) }
    },
    async loadSession(params) {
      log({ method: 'session/load', params })
      return {}
    },
    async closeSession(params) {
      log({ method: 'session/close', params })
      return {}
    },
    async prompt(params) {
      log({ method: 'session/prompt', params })
      const { sessionId } = params
      const session = state.get(sessionId)
      session.cancelled = false
      const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
      if (Object.hasOwn(SLASH_MODES, text)) {
        const { modeId, name } = SLASH_MODES[text]
        if (session.mode === modeId) {
          await say(sessionId, `Already in ${name} mode.`)
          return { stopReason: 'end_turn' }
        }
        const { allowAllChanged } = enterMode(session, modeId)
        await say(sessionId, `Switched to ${name} mode.`)
        setImmediate(async () => {
          await reportMode(sessionId, modeId)
          if (allowAllChanged) {
            await reportOptions(sessionId)
          }
        })
        return { stopReason: 'end_turn' }
      }
      if (!text.includes('call app_call')) {
        return { stopReason: 'end_turn' }
      }
      const toolCallId = `call-${Date.now()}`
      const rawInput = { app: 'my-space.my-graph', action: 'listNodes' }
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId, title: 'local-app_call', kind: 'other', status: 'pending' },
      })
      let allowed = session.allowAll === 'on'
      if (!allowed) {
        const { outcome } = await connection.requestPermission({
          sessionId,
          toolCall: { toolCallId, title: 'app_call', kind: 'other', status: 'pending', rawInput },
          options: PERMISSION_OPTIONS,
        })
        log({ method: 'permission answered', outcome })
        if (session.cancelled || outcome.outcome === 'cancelled') {
          return { stopReason: 'cancelled' }
        }
        allowed = outcome.outcome === 'selected' && outcome.optionId.startsWith('allow')
      }
      log({ method: 'tool', ran: allowed })
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' },
      })
      return { stopReason: 'end_turn' }
    },
    async cancel(params) {
      log({ method: 'session/cancel', params })
      const session = state.get(params.sessionId)
      if (session) {
        session.cancelled = true
      }
    },
  }),
  stream,
)
