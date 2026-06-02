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
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6'],
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'zai',
    label: 'z.ai (GLM Coding Plan)',
    endpoints: {
      anthropic: 'https://api.z.ai/api/anthropic',
      openai: 'https://api.z.ai/api/coding/paas/v4',
    },
    models: ['glm-4.6', 'glm-5.1'],
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
    id: 'google',
    label: 'Google',
    endpoints: { gemini: '' },
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
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
