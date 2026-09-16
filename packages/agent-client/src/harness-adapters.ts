import type { AgentProvider } from './agent-providers'
import type { AgentSelection } from './types'

export type Protocol = 'anthropic' | 'openai' | 'gemini' | 'native'

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
  // Builds extra spawn env from the selection's provider wiring, for harnesses
  // whose provider configuration cannot travel through the standard base-url /
  // key / model env vars and must instead be carried in a document of the
  // harness's own (OpenCode's config JSON). Receives the resolved key env var
  // name (the adapter's keyEnv, else the provider's).
  selectionEnv?: (provider: AgentProvider, selection: AgentSelection, keyEnv?: string) => Record<string, string>
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
    note: 'Auth with a Claude Pro/Max subscription: run `claude setup-token`, then paste the OAuth token as the API key secret.',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp@latest'],
    protocol: 'openai',
    baseUrlEnv: 'OPENAI_BASE_URL',
    keyEnv: 'OPENAI_API_KEY',
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
    note: 'Models come from the selected provider, wired into OpenCode automatically as an OpenAI-compatible provider — the chat model picker lists them as `provider/model`. Context variants like `[1m]` are not offered (the OpenAI-compatible endpoint rejects them). Leave the model blank for OpenCode\'s default.',
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
