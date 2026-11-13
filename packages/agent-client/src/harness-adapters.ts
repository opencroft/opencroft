import type { AuthenticateRequest, InitializeResponse, SessionNotification } from '@agentclientprotocol/sdk'

import type { AgentProvider } from './agent-providers'
import { copilotCompletedCall, opencodeCompletedCall } from './command-endings'
import { mergeHeaders } from './endpoint-headers'
import { ActionRequiredError } from './errors'
import type { McpToolNaming } from './local-tool-ref'
import type { AgentSelection } from './types'

// 'openai-responses' is an endpoint that serves OpenAI's Responses API
// (`/responses`), which is NOT implied by 'openai' (Chat Completions): many
// OpenAI-compatible servers implement only the latter. A provider lists it when
// the whole provider speaks it; a selection on any other 'openai' provider can
// opt in with `responsesApi` (see resolve.ts adapterOffered).
// 'github-copilot' is GitHub's own Copilot model routing, reached with a GitHub
// token rather than a provider endpoint.
export type Protocol = 'anthropic' | 'openai' | 'openai-responses' | 'gemini' | 'github-copilot' | 'native'

// A harness's own word that a turn it started is over: 'idle' when it simply
// finished (or was stopped), 'error' when the harness reports it ended broken.
export type HarnessTurnEnd = 'idle' | 'error'

// How a harness is put into "never ask, permit everything", the state a host
// forces when it skips approvals altogether.
// - 'mode': switch to the session mode classified as Bypass (session-modes).
// - 'config-option': set one of the session's config options to `value` and
//   leave the mode alone, for a harness whose approvals are a setting of
//   their own beside its modes.
export type BypassRoute = { kind: 'mode' } | { kind: 'config-option'; optionId: string; value: string }

export interface HarnessAdapter {
  id: string
  label: string
  command: string
  args: string[]
  protocol: Protocol
  baseUrlEnv?: string
  keyEnv?: string
  modelEnv?: string
  // How the harness sends the selection's `headers` with every request to the
  // provider endpoint: `{ env }`, an env var of `Name: Value` lines the
  // harness reads; 'wiring', the adapter's own provider wiring carries them
  // (selectionEnv, authenticate, or the in-process client). Unset: the harness
  // has no way to take them, and a host should not offer them.
  endpointHeaders?: { env: string } | 'wiring'
  note?: string
  // 'acp' (default): spawn an external ACP agent subprocess. 'native': run the
  // in-process harness (Vercel AI SDK) with native tools — no subprocess, no MCP.
  kind?: 'acp' | 'native'
  // Whether the agent accepts per-session MCP servers (the source of tool
  // support). Defaults to true. Set false for agents whose ACP bridge rejects
  // per-session MCP servers (e.g. OpenClaw), so the client sends an empty list.
  supportsTools?: boolean
  // Fixed environment for every spawn of this harness (e.g. forcing the
  // harness's auth mode); merged under the per-selection values.
  staticEnv?: Record<string, string>
  // Whether the harness supports the interactive OAuth login driven by
  // ./oauth-login: credentials live in the harness's own config files and are
  // rotated by the harness, not passed through an environment variable.
  supportsOauthLogin?: boolean
  // Whether the agent accepts `session/prompt` while a turn is already running
  // and feeds it into the live turn as streaming input ("steering"). This is
  // NOT an ACP capability — the protocol declares none for it — so the flag
  // encodes verified behavior of the specific bridge binary. Defaults to
  // false, meaning the engine queues mid-turn prompts until the turn ends.
  supportsMidTurnInput?: boolean
  // Whether the agent actually SENDS ACP elicitations (elicitation/create)
  // once the client declares the capability. Also not declarable over ACP —
  // agentCapabilities carries no elicitation field, so the client only ever
  // states its own support — hence, like supportsMidTurnInput, this encodes
  // verified behavior of the specific bridge binary. A host uses it to hide
  // its own fallback question tool from sessions whose harness asks natively
  // (the native path has no MCP request timeout; the tool does).
  supportsElicitation?: boolean
  // Whether an MCP-server refresh must close the session before resuming it.
  // The refresh sends the new server list on `session/resume`, which only
  // works if the harness rebuilds the session from that request. codex-acp
  // resumes through the app server's thread/resume, whose own contract
  // (ThreadResumeParams in codex-acp 1.13.1) is that resuming a thread that is
  // still running REJOINS it — so the new list plausibly never reaches the
  // thread. Closing first — codex-acp's close is thread/unsubscribe — is
  // meant to release the thread so the resume starts it afresh. Both halves
  // are read off the source, neither is measured, which is why no adapter
  // sets this yet. Defaults to false, and is honored only when the agent also
  // advertised `sessionCapabilities.close`.
  // claude-agent-acp needs none of this: it compares the resume request with
  // the live session and rebuilds the session itself when the MCP servers
  // differ (acp-agent.js getOrCreateSession, 0.79.0).
  mcpRefreshReopens?: boolean
  // Whether a session this harness forks has to be resumed before it takes a
  // prompt. claude-agent-acp answers `session/fork` by writing the forked
  // transcript and returning its id and nothing else (fork-session.js
  // forkSession; the same in 0.78.0, 0.79.0 and 0.81.2): it builds no live
  // session and ignores the request's MCP servers, and a prompt to that id is
  // refused with "Session not found" (acp-agent.js prompt) until a
  // session/resume builds one. ACP's fork "creates a new session", so this is
  // a gap in that bridge rather than the protocol's shape, and not a general
  // rule: codex-acp's fork is a live thread, and resuming it would rejoin the
  // thread under a fresh MCP token it may never receive (see
  // mcpRefreshReopens). Honored only when the agent advertised
  // `sessionCapabilities.resume`.
  forkNeedsResume?: boolean
  // Whether the engine resumes this harness's sessions by closing and loading
  // them again, for a harness that has no `session/resume` but loads and closes
  // sessions. A resume is what attaches a session to a process that restarted
  // and what hands a live session a changed MCP server list; without one both
  // fail. `session/load` does both, but it replays the whole conversation,
  // which the engine already holds and discards, and a process that still
  // holds the session refuses to load it again until it is closed. Measured on
  // the Copilot CLI 1.0.95: resume answers "Method not found", load on the
  // process holding the session answers "already loaded", and close then load
  // connects the new MCP servers and keeps the mode, the settings and the
  // model's history. Honored only when the agent advertised `loadSession` and
  // `sessionCapabilities.close` and not `sessionCapabilities.resume`.
  resumeByReload?: boolean
  // Advertised command names (as the harness spells them, without a leading
  // `/`) that are dropped from the session's `available_commands` before any
  // subscriber sees them. For commands a client should not offer: ones that
  // reach past the session (the harness process and every session sharing it,
  // the harness's stored state, files outside the session's cwd), and ones
  // that change session state the client shows (approvals, model) without
  // reporting the change. Hiding is not blocking: a prompt that spells one out
  // still goes to the harness.
  hiddenCommands?: string[]
  // Builds extra spawn env from the selection's provider wiring, for harnesses
  // whose provider configuration cannot travel through the standard base-url /
  // key / model env vars and must instead be carried in a document of the
  // harness's own (OpenCode's config JSON). Receives the resolved key env var
  // name (the adapter's keyEnv, else the provider's).
  selectionEnv?: (provider: AgentProvider, selection: AgentSelection, keyEnv?: string) => Record<string, string>
  // Builds the ACP `authenticate` request sent once per connection, right
  // after `initialize`, for harnesses that will not open a session until the
  // client authenticates (codex-acp). Receives the initialize response so the
  // adapter picks from the methods the agent actually advertised, and throws an
  // ActionRequiredError when it can't (no key, method not offered). Declaring
  // the hook is also what makes the client advertise gateway auth support
  // (`clientCapabilities.auth._meta.gateway`) on that connection — only there.
  // The request may carry the selection's key: the engine sends it on the
  // wire and nowhere else (never in logs, errors, events or the connection key).
  authenticate?: (provider: AgentProvider, selection: AgentSelection, init: InitializeResponse) => AuthenticateRequest
  // Env var naming the harness's own home directory (config, credentials,
  // transcripts). When set, every spawn points it at a directory the host owns
  // — `<selection.harnessHome>/<adapter id>`, created before the spawn — so
  // nothing the host user keeps in the harness's default home (a leftover
  // login, providers, MCP servers, approval settings, instructions) leaks into
  // the agent.
  homeEnv?: string
  // Further env vars pointed at a subdirectory of that same home (name ->
  // subdirectory), for state the harness reads through another tool's own
  // variable (the `gh` CLI's config directory). Only with `homeEnv`.
  homeScopedEnv?: Record<string, string>
  // Inherited environment the harness must not see: names, or prefixes ending
  // in `*`. Removed from the host's environment for a host spawn, and unset
  // inside the container for a container spawn, before the harness starts.
  // What the spawn itself sets is kept. For a harness that reads credentials
  // or configuration from variables the host or the agent's container may
  // carry for other purposes (a GH_TOKEN meant for the agent's git).
  scrubEnv?: string[]
  // Refuses a selection the harness cannot run, before anything is spawned:
  // throws an ActionRequiredError naming what the profile lacks.
  checkSelection?: (provider: AgentProvider | undefined, selection: AgentSelection) => void
  // What to make of the steering extension the harness advertises at connect
  // (`_meta.steering.supported`). 'trust' (default) turns mid-turn input on when
  // advertised; 'ignore' keeps the engine queueing mid-turn prompts regardless,
  // for a harness whose steering contract the engine doesn't handle yet.
  advertisedSteering?: 'trust' | 'ignore'
  // A note sent with a steer that lands while the turn still has tool calls
  // without a result, as its own content block (see delivery-note.ts). For a
  // harness that answers such a steer by cancelling the calls that had not
  // started yet, in words the model would otherwise misread. Unset means the
  // steer goes out as it is.
  steerDeliveryNote?: string
  // Reads the harness's own "this session is idle again" off one session
  // update. Needed for turns the harness starts ITSELF: a harness that
  // ignores `idleBehavior` answers a steer that finds no live turn with
  // `startedNewTurn`, and no session/prompt of ours belongs to that turn, so
  // nothing else can tell the engine it ended. Without it such a turn is still
  // delivered (never re-sent), but the engine cannot hold the session busy
  // for it, and a message sent meanwhile may start a turn beside it.
  harnessTurnEnd?: (update: SessionNotification['update']) => HarnessTurnEnd | undefined
  // How this harness's bypass is reached (see BypassRoute). Unset means the
  // mode route, which is how Claude Code and Codex reach theirs; a session
  // that offers no Bypass mode then has no bypass to force.
  bypass?: BypassRoute
  // How the harness names an MCP tool in the tool calls it announces, when it
  // is not `mcp__<server>__<tool>` (see local-tool-ref).
  mcpToolNaming?: McpToolNaming
  // For a harness that reports a failed turn only as reply text and records
  // the failure, typed, in a log under its home: the log's format, read
  // server-side (turn-failure-log.ts) and only for a host spawn, whose home
  // the server can reach. A name rather than the reader itself, because this
  // table is also bundled for the browser.
  failureLog?: FailureLogFormat
  // For a harness that settles every finished command as `completed`, however
  // it ended: how the call really ended, read from the output it settled with
  // (see command-endings). 'failed' or 'cancelled' replaces the status; nothing
  // keeps `completed`. The output itself is passed on as the harness sent it.
  settleCompletedCall?: (output: string) => 'failed' | 'cancelled' | undefined
  // Where the harness reads the instruction texts a host supplies (see
  // AgentClientOptions.loadInstructionFiles). Unset: the harness keeps its
  // own instruction files and the engine writes none.
  instructions?: InstructionTarget
}

export type FailureLogFormat = 'copilot-session-events'

// How often a harness reads an instruction file: before every turn, or once
// when a session starts (and, for Claude Code, after a compaction). A file
// read once per session needs the change note when it changes under a live
// session.
export type InstructionRereads = 'turn' | 'session'

// Where a harness reads the two instruction texts. The `shared` text belongs
// to the place the harness runs (a container, or the host) and goes to the
// harness's home-level file; the `agent` text belongs to one agent and goes
// to the file the harness reads in its working directory.
export interface InstructionTarget {
  // 'files': the engine writes the texts as the files below. 'system-prompt':
  // the harness takes its instructions as its system prompt, and has no file.
  channel: 'files' | 'system-prompt'
  home?: {
    // Resolved in the shell that runs the harness: `$NAME`, `${NAME}` and
    // `${NAME:-default}`, from the spawn's environment first.
    path: string
    // For a host spawn, a path relative to the working directory used instead
    // of `path`, so the engine never writes into the home of the user running
    // the host.
    hostPath?: string
    rereads: InstructionRereads
    // Whether every agent in the place reads this one file, rather than each
    // agent its own copy in its own harness home. A file found there that the
    // engine does not own is adopted as the place's shared text only when it
    // is shared: one agent's own file is not the place's.
    shared: boolean
  }
  workspace?: {
    // A file name in the working directory.
    name: string
    rereads: InstructionRereads
    // Where the agent text goes when the working directory already holds a
    // file of that name that the engine did not write (a repository's own):
    // 'local-file' writes `localName` beside it, 'home-section' adds a section
    // to the home file, which then has to be the agent's own.
    fallback: 'local-file' | 'home-section'
    localName?: string
  }
}

// Claude Code reads CLAUDE.md in every directory from the root down to its
// cwd, so for a host spawn the file one directory up is read by every agent
// whose workspace sits beside this one's.
const CLAUDE_INSTRUCTIONS: InstructionTarget = {
  channel: 'files',
  home: { path: '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/CLAUDE.md', hostPath: '../CLAUDE.md', rereads: 'session', shared: true },
  workspace: { name: 'CLAUDE.md', rereads: 'session', fallback: 'local-file', localName: 'CLAUDE.local.md' },
}

// Codex reads its home file at every turn and the project files when the
// environment changes (codex 0.156.1, codex-home/src/instructions/mod.rs).
const CODEX_INSTRUCTIONS: InstructionTarget = {
  channel: 'files',
  home: { path: '$CODEX_HOME/AGENTS.md', rereads: 'turn', shared: false },
  workspace: { name: 'AGENTS.md', rereads: 'session', fallback: 'home-section' },
}

// When the Copilot CLI re-reads either file is not established (its logic is
// compiled), so both are taken as read once per session.
const COPILOT_INSTRUCTIONS: InstructionTarget = {
  channel: 'files',
  home: { path: '$COPILOT_HOME/copilot-instructions.md', rereads: 'session', shared: false },
  workspace: { name: 'AGENTS.md', rereads: 'session', fallback: 'home-section' },
}

// OpenCode reads both before every model call (opencode-ai 1.18.31).
const OPENCODE_INSTRUCTIONS: InstructionTarget = {
  channel: 'files',
  home: { path: '$OPENCODE_CONFIG_DIR/AGENTS.md', rereads: 'turn', shared: false },
  workspace: { name: 'AGENTS.md', rereads: 'turn', fallback: 'home-section' },
}

// OpenCode assembles its model catalog from its OWN provider configuration:
// the standard OPENAI_* / *MODEL* env vars do nothing for it, and a provider
// that is not configured there never appears in the advertised `model` config
// option at all (measured against opencode-ai 1.18.31 — only its built-in
// free models are offered, with the provider's key env var set or not). Its
// config schema accepts an inline document through the OPENCODE_CONFIG_CONTENT
// env var, so each spawn carries one synthesized from the selection's provider
// wiring: an OpenAI-compatible provider entry pointing at the provider's
// endpoint, with the API key and each request header's value referenced as
// `{env:<NAME>}` so the document itself holds no secret. One empty model
// entry per provider-table id registers that id in the picker even where
// OpenCode's own model catalog doesn't know it; empty entries leave the
// catalog's names and context limits standing. The context-variant bracket ids (`[1m]`-style) are skipped — they
// are served by the provider's anthropic-style endpoints only; the
// OpenAI-compatible endpoint rejects them with "Unknown Model" (same
// measurement) — so advertising one would only invite a mid-turn failure.
//
// The env vars holding the request header values, one per header, numbered in
// the order of the selection's headers.
export const OPENCODE_HEADER_ENV_PREFIX = 'AGENT_ENDPOINT_HEADER_'

function opencodeSelectionEnv(
  provider: AgentProvider,
  selection: AgentSelection,
  keyEnv?: string,
): Record<string, string> {
  const models: Record<string, object> = {}
  for (const model of provider.models) {
    if (!model.includes('[')) {
      models[model] = {}
    }
  }
  const baseURL = selection.baseUrl || provider.endpoints.openai
  // Providers without an OpenAI-compatible endpoint are left to the harness's
  // own catalog (its model registry entries plus the standard key env var,
  // which it does honor for those) — synthesizing an entry here would override
  // that working catalog with an endpoint-less OpenAI-compatible one.
  if (!baseURL) {
    return {}
  }
  const headerEnv: Record<string, string> = {}
  const headers: Record<string, string> = {}
  for (const [index, [name, value]] of Object.entries(selection.headers ?? {}).entries()) {
    const env = `${OPENCODE_HEADER_ENV_PREFIX}${index}`
    headerEnv[env] = value
    headers[name] = `{env:${env}}`
  }
  return {
    ...headerEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [provider.id]: {
          npm: '@ai-sdk/openai-compatible',
          name: provider.label,
          options: {
            ...(baseURL ? { baseURL } : {}),
            ...(selection.apiKey && keyEnv ? { apiKey: `{env:${keyEnv}}` } : {}),
            ...(Object.keys(headers).length ? { headers } : {}),
          },
          models,
        },
      },
    }),
  }
}

// codex-acp takes no model variable: its thread config comes from the Codex
// config file, with CODEX_CONFIG (a JSON object) merged over it on every thread
// start, resume and fork. The profile's model goes there, so the first turn
// already runs on it; a `model[effort]` id is split into the model and Codex's
// `model_reasoning_effort` key, the bracket form codex-acp itself uses for
// combined ids.
function codexSelectionEnv(_provider: AgentProvider, selection: AgentSelection): Record<string, string> {
  const match = /^(.+)\[([^\]]+)\]$/.exec(selection.model)
  const model = match ? match[1] : selection.model
  const effort = match ? match[2] : undefined
  if (!model) {
    return {}
  }
  return {
    CODEX_CONFIG: JSON.stringify({ model, ...(effort ? { model_reasoning_effort: effort } : {}) }),
  }
}

// codex-acp opens no session until the client authenticates: an API key in the
// environment is only read inside its `api-key` method, and OPENAI_BASE_URL is
// ignored. The `gateway` method carries both endpoint and credential, holds
// them in the adapter process's memory (nothing written to the Codex home, no
// restart) and makes every thread use that provider — so it is used for OpenAI
// itself too, rather than a second code path. Verified against codex-acp
// 1.13.1 source (CodexAuthMethod.ts, CodexAcpClient.ts), not live.
//
// OpenAI's own endpoint, for a provider whose table endpoint is '' (the
// harness's default) when the harness has no default of its own to fall to.
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function codexGatewayAuth(
  provider: AgentProvider,
  selection: AgentSelection,
  init: InitializeResponse,
): AuthenticateRequest {
  if (!selection.apiKey) {
    throw new ActionRequiredError(
      'Codex needs an API key: set one on the agent profile (it is sent to the endpoint as a Bearer token).',
    )
  }
  const offered = (init.authMethods ?? []).some((method) => method.id === 'gateway')
  if (!offered) {
    throw new ActionRequiredError(
      "This Codex adapter does not offer gateway authentication, so the profile's endpoint and key cannot be applied.",
    )
  }
  const baseUrl =
    selection.baseUrl || provider.endpoints['openai-responses'] || provider.endpoints.openai || OPENAI_DEFAULT_BASE_URL
  return {
    methodId: 'gateway',
    _meta: {
      gateway: {
        baseUrl,
        headers: mergeHeaders({ Authorization: `Bearer ${selection.apiKey}` }, selection.headers),
        providerName: provider.label,
      },
    },
  }
}

// codex-acp forwards the Codex thread's status changes as a session info
// update with `_meta.codex.threadStatus` (CodexEventHandler.ts,
// `thread/status/changed`), and its own steering example treats `idle` and
// `systemError` as "the turn finished" (examples/steering.ts). That is the only
// end a turn it started from a steer has on the wire: the steering request is
// answered the moment that turn starts (CodexAcpServer.ts,
// startNewTurnFromExternalPrompt), and the turn's prompt response goes to
// nobody. Read from the 1.13.1 source, not observed live.
function codexHarnessTurnEnd(update: SessionNotification['update']): HarnessTurnEnd | undefined {
  if (update.sessionUpdate !== 'session_info_update') {
    return undefined
  }
  const codex = update._meta?.codex
  const status = codex && typeof codex === 'object' ? (codex as { threadStatus?: unknown }).threadStatus : undefined
  const type = status && typeof status === 'object' ? (status as { type?: unknown }).type : undefined
  if (type === 'idle') {
    return 'idle'
  }
  return type === 'systemError' ? 'error' : undefined
}

// The Copilot CLI takes its credential from the first of COPILOT_GITHUB_TOKEN,
// GH_TOKEN and GITHUB_TOKEN it finds, then a login stored in its home, then
// `gh auth token` (measured on 1.0.95: with none of the others it runs that
// and signs in as whoever the `gh` config belongs to). It also reads dozens of
// COPILOT_* variables (providers, models, tool approval, MCP and
// instructions). So none of those may be inherited: what the agent's Copilot
// runs on is only what its profile sets here. `gh` is pointed at a config
// directory inside the agent's own Copilot home, which holds no login.
const COPILOT_SCRUB_ENV = ['COPILOT_*', 'GH_*', 'GITHUB_*']
const COPILOT_HOME_SCOPED_ENV = { GH_CONFIG_DIR: 'gh' }

// Copilot's approvals are its `allow_all` config option (category
// `permissions`), beside its modes rather than one of them: with it on,
// nothing asks in any mode. Its `autopilot` mode turns it on too, but also
// keeps working until the task is done, which is more than skipping approvals
// asks for. Measured on 1.0.95: every session starts with it off, and leaving
// autopilot turns it off again, so whoever holds it on re-applies it after a
// mode change.
const COPILOT_BYPASS: BypassRoute = { kind: 'config-option', optionId: 'allow_all', value: 'on' }

// Of the 33 commands 1.0.95 advertises, the ones that reach past the agent's
// session: they take its files outside the workspace (`add-dir`, `cwd`), sign
// in to or publish through GitHub (`share`, `remote`), drive the server's
// desktop (`computer`), rewrite settings in the agent's Copilot home that hold
// for all its sessions (`mcp`, `plugin`, `sandbox`, `memory`), delete the
// stored sessions other threads load from (`session`), or, going by their
// descriptions (not watched firing), schedule turns that no client prompt
// starts (`every`, `after`).
// Also the ones that change what the command bar owns without telling it:
// approvals (`allow-all`, `permissions`, `reset-allowed-tools`; measured on
// 1.0.95, `/allow-all on` sends no `config_option_update`) and the session's
// model (`model`, which no config option reports on a BYOK session). `plan`
// and `autopilot` stay: Copilot reports their mode change, so the bar follows.
const COPILOT_HIDDEN_COMMANDS = [
  'allow-all',
  'permissions',
  'reset-allowed-tools',
  'model',
  'add-dir',
  'cwd',
  'share',
  'remote',
  'computer',
  'mcp',
  'plugin',
  'sandbox',
  'memory',
  'session',
  'every',
  'after',
]

// PINNED, like Codex: the integration was measured against this release, and
// a bump re-reads the changelog against what the integration relies on.
// `--no-auto-update` keeps the CLI from downloading and running a newer
// release on its own, which would undo the pin.
const COPILOT_ARGS = ['-y', '@github/copilot@1.0.95', '--acp', '--no-auto-update']

// BYOK: the profile's provider reaches Copilot through its COPILOT_PROVIDER_*
// variables, which replace GitHub's model routing and need no GitHub sign-in.
// Only OpenAI-style endpoints are wired: the Responses API where the provider
// or the profile says the endpoint serves it, Chat Completions otherwise.
function copilotProviderEnv(provider: AgentProvider, selection: AgentSelection): Record<string, string> {
  const responses = provider.endpoints['openai-responses'] !== undefined || selection.responsesApi === true
  return {
    COPILOT_PROVIDER_BASE_URL: selection.baseUrl || provider.endpoints.openai || OPENAI_DEFAULT_BASE_URL,
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_WIRE_API: responses ? 'responses' : 'completions',
  }
}

// Copilot answers a BYOK turn it cannot make (no model, a refused key) with
// the failure as agent text after several retries, not as an error, so what is
// missing is refused here instead.
function copilotProviderCheck(_provider: AgentProvider | undefined, selection: AgentSelection): void {
  if (!selection.model) {
    throw new ActionRequiredError(
      "GitHub Copilot needs a model on the agent profile: with the profile's own provider it has no default model.",
    )
  }
  if (!selection.apiKey) {
    throw new ActionRequiredError(
      'GitHub Copilot needs an API key on the agent profile (it is sent to the endpoint as a Bearer token).',
    )
  }
}

// Copilot accepts fine-grained personal access tokens and GitHub App tokens,
// not classic personal access tokens (GitHub's Copilot CLI authentication
// docs). A classic one would only fail later as "Authentication required".
function copilotSubscriptionCheck(_provider: AgentProvider | undefined, selection: AgentSelection): void {
  if (!selection.apiKey) {
    throw new ActionRequiredError(
      'GitHub Copilot (subscription) needs a GitHub token on the agent profile: a fine-grained personal access token (github_pat_…) with the Copilot Requests permission, set as the API key.',
    )
  }
  if (selection.apiKey.startsWith('ghp_')) {
    throw new ActionRequiredError(
      'GitHub Copilot does not accept classic personal access tokens (ghp_…): set a fine-grained token (github_pat_…) with the Copilot Requests permission as the API key.',
    )
  }
}

// Environment every spawn of the Claude Agent SDK bridge gets — see the note
// on the 'claude' adapter below.
const CLAUDE_AGENT_ENV: Record<string, string> = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

// WORKAROUND, see delivery-note.ts. The bridge steers at the
// SDK's `now` priority, which aborts the running cycle, and Claude Code answers
// every issued tool call that had not started with its generic user-cancel
// text. Remove once the bridge delivers a steer without aborting issued tool
// calls, or once the harness's own skip wording reaches the model.
const CLAUDE_STEER_DELIVERY_NOTE = [
  'This message arrived while tool calls of yours were still pending, and delivering it can cancel',
  'the ones that had not started yet. A cancelled call reports "The user doesn\'t want to take this',
  'action right now. STOP what you are doing and wait for the user to tell you how to proceed."',
  'Here that is not a refusal and not an instruction to stop: nothing refused the call. Re-run it if',
  'it is still needed, and take this message into account.',
].join(' ')

export const HARNESS_ADAPTERS: HarnessAdapter[] = [
  {
    id: 'native',
    label: 'Custom',
    kind: 'native',
    // command/args are unused: ensureConnection short-circuits before spawning.
    command: '',
    args: [],
    // Offered for every provider with an endpoint of an API it speaks (Chat
    // Completions, Responses, Anthropic Messages; resolve.ts
    // `nativeApisOffered`), not by this protocol alone, which names the
    // OpenAI-compatible endpoint the env vars below describe.
    protocol: 'openai',
    baseUrlEnv: 'OPENAI_BASE_URL',
    keyEnv: 'OPENAI_API_KEY',
    // Its OpenAI-compatible client sends them (endpoint.ts, models.ts).
    endpointHeaders: 'wiring',
    // Its own ask_user tool sends a form elicitation through the client and
    // waits in the turn for the answer (native-harness.ts askUserTool).
    supportsElicitation: true,
    instructions: { channel: 'system-prompt' },
    note: 'In-process harness — runs the agent loop directly with native tools (no subprocess, no MCP). Reaches any OpenAI-compatible model.',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    protocol: 'anthropic',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    modelEnv: 'ANTHROPIC_MODEL',
    // Claude Code adds these `Name: Value` lines to every API request; the
    // Claude Agent SDK lists the variable as a companion of ANTHROPIC_BASE_URL
    // (read from @anthropic-ai/claude-agent-sdk 0.3.316, not observed live).
    endpointHeaders: { env: 'ANTHROPIC_CUSTOM_HEADERS' },
    // The bridge enqueues an overlapping session/prompt onto the SDK's
    // streaming input, so the live turn picks it up at the next step boundary
    // (verified against claude-agent-acp v0.60.0; implementation-defined since
    // the adapter spawns @latest). Disabled for now: overlapping responses
    // stream back with no rendered boundary between them and concatenate into
    // one block. Flip back once clients split responses on the messageId the
    // bridge stamps on its message chunks — and require the same verification
    // pair (steering semantics + a boundary signal) before enabling any other
    // adapter.
    supportsMidTurnInput: false,
    // Verified 2026-09-16 against claude-agent-acp 0.77.0: with the form/url
    // client capabilities declared, AskUserQuestion arrives as a form
    // elicitation. Implementation-defined for the same @latest reason as the
    // note above.
    supportsElicitation: true,
    // The bridge's fork is a transcript on disk, not a session — see the flag.
    // Implementation-defined for the same @latest reason as the notes above.
    forkNeedsResume: true,
    // The Claude Agent SDK hands the model its plan tools (TodoWrite,
    // TaskCreate/Update/List) only behind this opt-in flag, default off, and
    // the bridge's TodoWrite -> `plan` translation is the only source of the
    // plan a chat draws. Here, on the spawn, rather than in the host's own
    // environment: a harness run in a container gets only the variables its
    // spawn names (see wrapInDocker), so a flag inherited from the host's
    // process reached host-run agents and silently never reached the rest.
    staticEnv: CLAUDE_AGENT_ENV,
    steerDeliveryNote: CLAUDE_STEER_DELIVERY_NOTE,
    instructions: CLAUDE_INSTRUCTIONS,
  },
  {
    id: 'claude-subscription',
    label: 'Claude Code (subscription)',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
    protocol: 'anthropic',
    // No baseUrlEnv: always hit the default Anthropic endpoint and bill via the
    // OAuth token (subscription), never a provider override.
    keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    modelEnv: 'ANTHROPIC_MODEL',
    // Same bridge binary as 'claude' — see the notes there.
    supportsMidTurnInput: false,
    supportsElicitation: true,
    forkNeedsResume: true,
    staticEnv: CLAUDE_AGENT_ENV,
    steerDeliveryNote: CLAUDE_STEER_DELIVERY_NOTE,
    instructions: CLAUDE_INSTRUCTIONS,
    note: 'Auth with a Claude Pro/Max subscription: run `claude setup-token`, then paste the OAuth token as the API key secret.',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'npx',
    // PINNED, unlike every other adapter here (which run @latest). The Codex
    // integration was written against this release's source without a live
    // session (no key was available), so the only honest claim the Harness
    // Support page can make is "integrated against 1.13.1". A bump is a
    // deliberate change that re-reads the changelog against that page's rows.
    // This is the maintained agentclientprotocol adapter over the Codex App
    // Server; @zed-industries/codex-acp is frozen upstream.
    args: ['-y', '@agentclientprotocol/codex-acp@1.13.1'],
    // codex-acp speaks the Responses API only (its gateway provider is
    // `wire_api: "responses"`), so Chat-Completions-only endpoints never offer it.
    protocol: 'openai-responses',
    // No baseUrlEnv / modelEnv: codex-acp reads neither OPENAI_BASE_URL nor a
    // model variable. The endpoint travels in the gateway authenticate request
    // below, the model in CODEX_CONFIG (codexSelectionEnv).
    keyEnv: 'CODEX_API_KEY',
    homeEnv: 'CODEX_HOME',
    // Hides the browser ChatGPT login, which would open a browser on the
    // server; this adapter always authenticates with the profile's key.
    staticEnv: { NO_BROWSER: '1' },
    selectionEnv: codexSelectionEnv,
    authenticate: codexGatewayAuth,
    // The gateway request carries them beside the key (codexGatewayAuth).
    endpointHeaders: 'wiring',
    harnessTurnEnd: codexHarnessTurnEnd,
    // `/logout` signs out the account the adapter process holds (the
    // profile's gateway credential), breaking the session for everyone on it.
    hiddenCommands: ['logout'],
    instructions: CODEX_INSTRUCTIONS,
    note: "Needs an endpoint that serves OpenAI's Responses API: OpenAI itself, or an OpenAI-compatible endpoint marked as supporting it. The profile's key is sent to that endpoint as a Bearer token.",
  },
  {
    id: 'codex-subscription',
    label: 'Codex (ChatGPT subscription)',
    command: 'npx',
    // Same pinned bridge as 'codex' — see the notes there.
    args: ['-y', '@agentclientprotocol/codex-acp@1.13.1'],
    protocol: 'openai-responses',
    // No keyEnv and no authenticate hook: the ChatGPT login is made once by
    // ./oauth-login's device-code flow and stored by Codex as auth.json in its
    // home, which it refreshes itself. A session only reads it, so a harness
    // home without one answers session/new with authRequired.
    homeEnv: 'CODEX_HOME',
    // Hides the browser ChatGPT login, which would open a browser on the
    // server; the device-code login needs no browser here.
    staticEnv: { NO_BROWSER: '1' },
    selectionEnv: codexSelectionEnv,
    supportsOauthLogin: true,
    // Same reason as the API-key entry: `/logout` signs out the process's
    // stored ChatGPT login for every session on it.
    hiddenCommands: ['logout'],
    advertisedSteering: 'ignore',
    instructions: CODEX_INSTRUCTIONS,
    note: "Sign in with your ChatGPT account: the sign-in shows a verification link and a one-time code to enter on that page. The login is kept in this agent's own harness home, survives restarts and is refreshed by Codex itself; no API key is used.",
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    command: 'npx',
    args: ['-y', '@qwen-code/qwen-code@latest', '--acp', '--experimental-skills'],
    protocol: 'openai',
    baseUrlEnv: 'OPENAI_BASE_URL',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'npx',
    args: ['-y', '@google/gemini-cli@latest', '--acp'],
    protocol: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    note: 'Model accepts a Gemini CLI alias (auto, pro, flash) or a concrete Gemini model id.',
  },
  {
    id: 'gemini-subscription',
    label: 'Gemini CLI (subscription)',
    command: 'npx',
    args: ['-y', '@google/gemini-cli@latest', '--acp'],
    protocol: 'gemini',
    // No keyEnv: credentials come from the CLI's own token manager, populated
    // by the interactive Google OAuth login and rotated by the CLI itself.
    modelEnv: 'GEMINI_MODEL',
    staticEnv: { GEMINI_DEFAULT_AUTH_TYPE: 'oauth-personal' },
    supportsOauthLogin: true,
    note: 'Sign in with your Google account (Gemini subscription); credentials are stored and rotated by the CLI itself.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'npx',
    args: ['-y', 'opencode-ai@latest', 'acp'],
    protocol: 'native',
    // OpenCode carries NO model env var and builds its model catalog from its
    // OWN provider configuration — the standard OPENAI_*/ANTHROPIC_* env vars
    // do nothing for it, the provider's key env var included. Without
    // selectionEnv below, only its built-in free models are advertised as the
    // `model` config option at session start and a profile's model can never
    // match (measured against opencode-ai 1.18.31). With it, the selection's
    // provider is configured via the OPENCODE_CONFIG_CONTENT env var, the chat
    // model picker lists its models as `provider/model`, and createSession's
    // model-config step applies the profile model when it matches an
    // advertised id — a model that matches nothing is reported as an error
    // event instead of being skipped silently.
    selectionEnv: opencodeSelectionEnv,
    // The provider entry carries them as its `headers` option (opencodeSelectionEnv).
    endpointHeaders: 'wiring',
    settleCompletedCall: opencodeCompletedCall,
    // A home of its own, as Codex and Copilot have, so its home-level
    // instruction file is this agent's. Without the second variable OpenCode
    // also reads Claude Code's home file (`~/.claude/CLAUDE.md`) whenever its
    // own has none, which in a shared container is another harness's text.
    homeEnv: 'OPENCODE_CONFIG_DIR',
    staticEnv: { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1' },
    instructions: OPENCODE_INSTRUCTIONS,
    note: "Models come from the selected provider, wired into OpenCode automatically as an OpenAI-compatible provider — the chat model picker lists them as `provider/model`. Context variants like `[1m]` are not offered (the OpenAI-compatible endpoint rejects them). Leave the model blank for OpenCode's default.",
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    command: 'npx',
    args: COPILOT_ARGS,
    protocol: 'openai',
    keyEnv: 'COPILOT_PROVIDER_API_KEY',
    // Read both as the agent's model and as the model name sent to the
    // provider (COPILOT_PROVIDER_WIRE_MODEL defaults to it). The only model
    // a BYOK session has: it advertises no model option (Copilot has no
    // catalog for the provider), and its `/model <id>` command, hidden here,
    // takes any id unchecked. The subscription advertises a real one.
    modelEnv: 'COPILOT_MODEL',
    // No supportsElicitation, on either variant: over ACP, Copilot 1.0.95
    // offers the model no question tool of its own in any mode, with the form
    // and url elicitation capabilities declared, so it never asks natively and
    // the host's question tool stays. Copilot cancels that tool's call after
    // about three minutes (its MCP request timeout, settable only for servers
    // in its own config file, not for one sent in session/new).
    homeEnv: 'COPILOT_HOME',
    homeScopedEnv: COPILOT_HOME_SCOPED_ENV,
    scrubEnv: COPILOT_SCRUB_ENV,
    selectionEnv: copilotProviderEnv,
    checkSelection: copilotProviderCheck,
    resumeByReload: true,
    bypass: COPILOT_BYPASS,
    hiddenCommands: COPILOT_HIDDEN_COMMANDS,
    mcpToolNaming: 'server-dash-tool',
    failureLog: 'copilot-session-events',
    settleCompletedCall: copilotCompletedCall,
    instructions: COPILOT_INSTRUCTIONS,
    note: "The Copilot CLI on the profile's own provider, endpoint, key and model (an OpenAI-compatible endpoint); no GitHub account or Copilot subscription is used.",
  },
  {
    id: 'copilot-subscription',
    label: 'GitHub Copilot (subscription)',
    command: 'npx',
    args: COPILOT_ARGS,
    protocol: 'github-copilot',
    keyEnv: 'COPILOT_GITHUB_TOKEN',
    modelEnv: 'COPILOT_MODEL',
    homeEnv: 'COPILOT_HOME',
    homeScopedEnv: COPILOT_HOME_SCOPED_ENV,
    scrubEnv: COPILOT_SCRUB_ENV,
    checkSelection: copilotSubscriptionCheck,
    // Same CLI as 'copilot' — see the measurement on the flag.
    resumeByReload: true,
    bypass: COPILOT_BYPASS,
    hiddenCommands: COPILOT_HIDDEN_COMMANDS,
    mcpToolNaming: 'server-dash-tool',
    failureLog: 'copilot-session-events',
    settleCompletedCall: copilotCompletedCall,
    instructions: COPILOT_INSTRUCTIONS,
    note: 'Uses your GitHub Copilot subscription: set a fine-grained personal access token (github_pat_…) with the Copilot Requests permission as the API key. Classic tokens (ghp_…) are not accepted.',
  },
  {
    id: 'auggie',
    label: 'Auggie CLI',
    command: 'npx',
    args: ['-y', '@augmentcode/auggie@latest', '--acp'],
    protocol: 'native',
    keyEnv: 'AUGMENT_SESSION_AUTH',
    note: 'Auth via `auggie login`, or paste the AUGMENT_SESSION_AUTH session token below.',
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    command: 'npx',
    args: ['-y', '@qoder-ai/qodercli@latest', '--acp'],
    protocol: 'native',
    keyEnv: 'QODER_PERSONAL_ACCESS_TOKEN',
    note: 'Auth via /login, or paste a Qoder personal access token below.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    command: 'npx',
    args: ['-y', 'openclaw@latest', 'acp'],
    protocol: 'native',
    // The OpenClaw ACP bridge rejects per-session MCP servers; configure MCP on
    // the gateway/agent instead, so the client sends an empty server list.
    supportsTools: false,
    note: 'Bridges to an OpenClaw Gateway; configure the gateway and token on the host.',
  },
]
