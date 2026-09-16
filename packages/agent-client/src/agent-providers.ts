import type { Protocol } from './harness-adapters'

export interface AgentProvider {
  id: string
  label: string
  endpoints: Partial<Record<Protocol, string>>
  models: string[]
  keyEnv: string
}

export const AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    endpoints: { anthropic: '' },
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5'],
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'zai',
    label: 'z.ai (GLM Coding Plan)',
    endpoints: {
      anthropic: 'https://api.z.ai/api/anthropic',
      openai: 'https://api.z.ai/api/coding/paas/v4',
    },
    // Verified against the endpoint above: z.ai rejects the bracketed
    // context-variant form (`glm-5.2[1m]`) that it used to accept, and now
    // serves glm-5.3 for any 5.x id it still recognises. glm-5.3-flash is a
    // distinct, faster model code whose thinking cannot be disabled. The
    // `[1m]` ids opt into the 1M-token window the plain ids don't serve;
    // they are listed per the coding-plan docs and not yet verified against
    // the endpoint — pair them with a configured 1,000,000 contextWindow.
    // Measured 2026-09-16: the OPENAI-compatible coding endpoint rejects the
    // bracketed ids outright ("Unknown Model"), while the anthropic-style
    // endpoint serves them (a Claude-Code bridge runs `glm-5.3-flash[1m]`
    // there); that endpoint's catalog serves `glm-5.3-flash` with a
    // 1,000,000-token window, so the bracket form is redundant on it. The
    // OpenCode adapter therefore excludes bracketed ids — see
    // opencodeSelectionEnv in harness-adapters.
    models: ['glm-4.6', 'glm-5.1', 'glm-5.3', 'glm-5.3[1m]', 'glm-5.3-flash', 'glm-5.3-flash[1m]'],
    keyEnv: 'ZAI_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoints: {
      anthropic: 'https://openrouter.ai/api',
      openai: 'https://openrouter.ai/api/v1',
    },
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'],
    keyEnv: 'OPENROUTER_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpoints: { openai: '' },
    models: ['gpt-5', 'gpt-5-codex'],
    keyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (custom)',
    // Base URL is supplied per-selection (AgentSelection.baseUrl); models are
    // loaded dynamically from the endpoint's `/models` route.
    endpoints: { openai: '' },
    models: [],
    keyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'google',
    label: 'Google',
    endpoints: { gemini: '' },
    // Gemini CLI model aliases — the CLI resolves each to the current model
    // generation, so the list survives model turnover. Concrete model ids can
    // be typed in as a custom value.
    models: ['auto', 'pro', 'flash', 'flash-lite'],
    keyEnv: 'GEMINI_API_KEY',
  },
  {
    id: 'dashscope',
    label: 'DashScope (Qwen)',
    endpoints: {
      openai: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
    models: ['qwen3-coder-plus'],
    keyEnv: 'DASHSCOPE_API_KEY',
  },
]
