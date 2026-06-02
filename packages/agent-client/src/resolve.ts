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
      const baseUrl = provider.endpoints[adapter.protocol]
      if (adapter.baseUrlEnv && baseUrl) {
        env[adapter.baseUrlEnv] = baseUrl
      }
      if (adapter.modelEnv && selection.model) {
        env[adapter.modelEnv] = selection.model
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
