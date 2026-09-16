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
    // OpenCode carries NO model env var: unlike Claude Code (ANTHROPIC_MODEL),
    // it advertises its model list as a `model` config option at session start
    // and switches via session/set_config_option — so the chat model picker
    // drives it live, and a profile's model is applied at start when it matches
    // an advertised option (see createSession's model-config step, gated on the
    // absent modelEnv). The advertised list is whatever OpenCode's own provider
    // auth exposes (ids are `provider/model`, e.g. `anthropic/claude-fable-5`),
    // so the key below — or an `opencode auth login` — is what populates it.
    note: 'Models come from OpenCode itself: whatever providers you have configured there (via the key below, or `opencode auth login`) appear in the chat model picker as `provider/model`. Set the profile model to one of those ids, or leave it blank for OpenCode\'s default.',
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
