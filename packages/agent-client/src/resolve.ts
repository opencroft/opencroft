import { AGENT_PROVIDERS, type AgentProvider } from './agent-providers'
import { HARNESS_ADAPTERS, type HarnessAdapter } from './harness-adapters'
import type { AgentSelection, SpawnConfig } from './types'

export function findProvider(id: string): AgentProvider | undefined {
  return AGENT_PROVIDERS.find((provider) => provider.id === id)
}

export function findAdapter(id: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((adapter) => adapter.id === id)
}

export function adaptersForProvider(providerId: string): HarnessAdapter[] {
  const provider = findProvider(providerId)
  if (!provider) {
    return []
  }
  return HARNESS_ADAPTERS.filter((adapter) => adapter.protocol === 'native' || provider.endpoints[adapter.protocol] !== undefined)
}

export function buildSpawnConfig(selection: AgentSelection): SpawnConfig {
  const adapter = findAdapter(selection.adapterId)
  const provider = findProvider(selection.providerId)
  const env: Record<string, string> = {}

  if (adapter && provider) {
    const keyEnv = adapter.keyEnv ?? (adapter.protocol === 'native' ? provider.keyEnv : undefined)
    if (keyEnv && selection.apiKey) {
      env[keyEnv] = selection.apiKey
    }
    if (adapter.protocol !== 'native') {
      // A per-selection baseUrl override (custom OpenAI-compatible endpoint)
      // takes precedence over the provider's table endpoint.
      const baseUrl = selection.baseUrl || provider.endpoints[adapter.protocol]
      if (adapter.baseUrlEnv && baseUrl) {
        env[adapter.baseUrlEnv] = baseUrl
      }
      if (adapter.modelEnv && selection.model) {
        env[adapter.modelEnv] = selection.model
      }
    } else if ('openai' in provider.endpoints) {
      // Native-protocol harnesses (OpenCode, etc.) configure their own
      // provider, but most honor the standard OpenAI env vars. When the
      // provider exposes an OpenAI-compatible endpoint, export base URL /
      // key / model under those names so a custom endpoint hooks up without
      // extra per-harness config. (Harnesses that ignore these vars still
      // fall back to their own config.)
      const baseUrl = selection.baseUrl || provider.endpoints.openai
      if (baseUrl) {
        env.OPENAI_BASE_URL = baseUrl
      }
      if (selection.apiKey) {
        env.OPENAI_API_KEY = selection.apiKey
      }
      if (selection.model) {
        env.OPENAI_MODEL = selection.model
      }
    }
  }

  return {
    command: adapter?.command ?? 'npx',
    args: adapter?.args ?? [],
    cwd: selection.cwd,
    env,
  }
}
