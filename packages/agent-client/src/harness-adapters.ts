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
    args: ['-y', '@google/gemini-cli@latest', '--experimental-acp'],
    protocol: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'npx',
    args: ['-y', 'opencode-ai@latest', 'acp'],
    protocol: 'native',
    note: 'Model and provider are configured in OpenCode itself; the key below is exported for it.',
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
    note: 'Bridges to an OpenClaw Gateway; configure the gateway and token on the host.',
  },
]
