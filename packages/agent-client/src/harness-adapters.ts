import type { AuthenticateRequest, InitializeResponse } from '@agentclientprotocol/sdk'

import type { AgentProvider } from './agent-providers'
import type { AgentSelection } from './types'

// 'openai-responses' is an endpoint that serves OpenAI's Responses API
// (`/responses`), which is NOT implied by 'openai' (Chat Completions): many
// OpenAI-compatible servers implement only the latter. A provider lists it when
// the whole provider speaks it; a selection on any other 'openai' provider can
// opt in with `responsesApi` (see resolve.ts adapterOffered).
export type Protocol = 'anthropic' | 'openai' | 'openai-responses' | 'gemini' | 'native'

export interface HarnessAdapter {
  id: string
  label: string
  command: string
  args: string[]
  protocol: Protocol
  baseUrlEnv?: string
  keyEnv?: string
  modelEnv?: string
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
  // Builds extra spawn env from the selection's provider wiring, for harnesses
  // whose provider configuration cannot travel through the standard base-url /
  // key / model env vars and must instead be carried in a document of the
  // harness's own (OpenCode's config JSON). Receives the resolved key env var
  // name (the adapter's keyEnv, else the provider's).
  selectionEnv?: (provider: AgentProvider, selection: AgentSelection, keyEnv?: string) => Record<string, string>
  // Builds the ACP `authenticate` request sent once per connection, right
  // after `initialize`, for harnesses that will not open a session until the
  // client authenticates (codex-acp). Receives the initialize response so the
  // adapter picks from the methods the agent actually advertised, and throws a
  // user-facing Error when it can't (no key, method not offered). Declaring
  // the hook is also what makes the client advertise gateway auth support
  // (`clientCapabilities.auth._meta.gateway`) on that connection — only there.
  // The request may carry the selection's key: the engine sends it on the
  // wire and nowhere else (never in logs, errors, events or the connection key).
  authenticate?: (provider: AgentProvider, selection: AgentSelection, init: InitializeResponse) => AuthenticateRequest
  // Env var naming the harness's own home directory (config, credentials,
  // transcripts). When set, every spawn points it at a directory OpenCroft owns
  // — `<selection.harnessHome>/<adapter id>`, created before the spawn — so
  // nothing the host user keeps in the harness's default home (a leftover
  // login, providers, MCP servers, approval settings, instructions) leaks into
  // the agent.
  homeEnv?: string
  // What to make of the steering extension the harness advertises at connect
  // (`_meta.steering.supported`). 'trust' (default) turns mid-turn input on when
  // advertised; 'ignore' keeps the engine queueing mid-turn prompts regardless,
  // for a harness whose steering contract the engine doesn't handle yet.
  advertisedSteering?: 'trust' | 'ignore'
}

// OpenCode assembles its model catalog from its OWN provider configuration:
// the standard OPENAI_* / *MODEL* env vars do nothing for it, and a provider
// that is not configured there never appears in the advertised `model` config
// option at all (measured against opencode-ai 1.18.31 — only its built-in
// free models are offered, with the provider's key env var set or not). Its
// config schema accepts an inline document through the OPENCODE_CONFIG_CONTENT
// env var, so each spawn carries one synthesized from the selection's provider
// wiring: an OpenAI-compatible provider entry pointing at the provider's
// endpoint, with the API key referenced as `{env:<KEY>}` so the document
// itself holds no secret. One empty model entry per provider-table id
// registers that id in the picker even where OpenCode's own model catalog
// doesn't know it; empty entries leave the catalog's names and context limits
// standing. The context-variant bracket ids (`[1m]`-style) are skipped — they
// are served by the provider's anthropic-style endpoints only; the
// OpenAI-compatible endpoint rejects them with "Unknown Model" (same
// measurement) — so advertising one would only invite a mid-turn failure.
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
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [provider.id]: {
          npm: '@ai-sdk/openai-compatible',
          name: provider.label,
          options: {
            ...(baseURL ? { baseURL } : {}),
            ...(selection.apiKey && keyEnv ? { apiKey: `{env:${keyEnv}}` } : {}),
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
export const CODEX_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function codexGatewayAuth(
  provider: AgentProvider,
  selection: AgentSelection,
  init: InitializeResponse,
): AuthenticateRequest {
  if (!selection.apiKey) {
    throw new Error(
      'Codex needs an API key: set one on the agent profile (it is sent to the endpoint as a Bearer token).',
    )
  }
  const offered = (init.authMethods ?? []).some((method) => method.id === 'gateway')
  if (!offered) {
    throw new Error(
      "This Codex adapter does not offer gateway authentication, so the profile's endpoint and key cannot be applied.",
    )
  }
  const baseUrl =
    selection.baseUrl || provider.endpoints['openai-responses'] || provider.endpoints.openai || CODEX_DEFAULT_BASE_URL
  return {
    methodId: 'gateway',
    _meta: {
      gateway: {
        baseUrl,
        headers: { Authorization: `Bearer ${selection.apiKey}` },
        providerName: provider.label,
      },
    },
  }
}

// Environment every spawn of the Claude Agent SDK bridge gets — see the note
// on the 'claude' adapter below.
const CLAUDE_AGENT_ENV: Record<string, string> = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

export const HARNESS_ADAPTERS: HarnessAdapter[] = [
  {
    id: 'native',
    label: 'Custom',
    kind: 'native',
    // command/args are unused: ensureConnection short-circuits before spawning.
    command: '',
    args: [],
    // Reached via the provider's OpenAI-compatible endpoint, so this adapter is
    // offered for every provider that exposes one.
    protocol: 'openai',
    baseUrlEnv: 'OPENAI_BASE_URL',
    keyEnv: 'OPENAI_API_KEY',
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
    // The Claude Agent SDK hands the model its plan tools (TodoWrite,
    // TaskCreate/Update/List) only behind this opt-in flag, default off, and
    // the bridge's TodoWrite -> `plan` translation is the only source of the
    // plan a chat draws. Here, on the spawn, rather than in the host's own
    // environment: a harness run in a container gets only the variables its
    // spawn names (see wrapInDocker), so a flag inherited from the host's
    // process reached host-run agents and silently never reached the rest.
    staticEnv: CLAUDE_AGENT_ENV,
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
    staticEnv: CLAUDE_AGENT_ENV,
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
    // codex-acp advertises steering, but its `_session/steering` ignores
    // `idleBehavior` and answers `startedNewTurn` with a turn of its own, which
    // the engine would re-deliver as a prompt. Remove this line in the change
    // that teaches steerIntoRunningTurn to treat `startedNewTurn` as delivered.
    advertisedSteering: 'ignore',
    note: "Needs an endpoint that serves OpenAI's Responses API: OpenAI itself, or an OpenAI-compatible endpoint marked as supporting it. The profile's key is sent to that endpoint as a Bearer token.",
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
    note: "Models come from the selected provider, wired into OpenCode automatically as an OpenAI-compatible provider — the chat model picker lists them as `provider/model`. Context variants like `[1m]` are not offered (the OpenAI-compatible endpoint rejects them). Leave the model blank for OpenCode's default.",
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    command: 'npx',
    args: ['-y', '@github/copilot-language-server@latest', '--acp'],
    protocol: 'native',
    note: 'Sign in with your GitHub Copilot subscription via the browser device flow on first run.',
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
