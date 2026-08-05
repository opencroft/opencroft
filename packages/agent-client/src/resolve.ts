import { hostname } from 'node:os'

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
  return HARNESS_ADAPTERS.filter(
    (adapter) => adapter.protocol === 'native' || provider.endpoints[adapter.protocol] !== undefined,
  )
}

export function buildSpawnConfig(selection: AgentSelection): SpawnConfig {
  const adapter = findAdapter(selection.adapterId)
  const provider = findProvider(selection.providerId)
  const env: Record<string, string> = {}

  if (adapter?.staticEnv) {
    Object.assign(env, adapter.staticEnv)
  }
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

  const spawnConfig: SpawnConfig = {
    command: adapter?.command ?? 'npx',
    args: adapter?.args ?? [],
    cwd: selection.cwd,
    env,
  }
  if (selection.containerName) {
    return wrapInDocker(spawnConfig, selection.containerName)
  }
  return spawnConfig
}

// Rewrap a host spawn config to run the harness inside a Docker container via
// `docker exec`. Env vars are forwarded by name (`-e NAME`) so their values stay
// out of the argv. The per-agent workdir may not exist in the container yet, so
// it's created and entered before exec'ing the harness (which then inherits the
// stdio pipes directly).
function wrapInDocker(config: SpawnConfig, container: string): SpawnConfig {
  const envFlags = Object.keys(config.env).flatMap((name) => ['-e', name])
  const dir = shellQuote(config.cwd)
  const inner = config.cwd
    ? ['sh', '-c', `mkdir -p ${dir} && cd ${dir} && exec "$0" "$@"`, config.command, ...config.args]
    : [config.command, ...config.args]
  return {
    command: 'docker',
    args: ['exec', '-i', ...envFlags, container, ...inner],
    // The docker client runs on the host; the container workdir is set above.
    cwd: '',
    env: config.env,
  }
}

// Single-quote a value for safe embedding in a `sh -c` script.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

// The internal MCP server advertises 127.0.0.1 by default, since it normally
// shares the harness's own network namespace. That breaks once the harness
// runs via wrapInDocker() above: 127.0.0.1 inside that sibling container is
// its own loopback, not this process's. Docker's embedded DNS resolves this
// container's own name/hostname for any sibling container on the same
// user-defined network, so swap in our hostname (Docker sets it to the short
// container id by default, which is one of those resolvable names) — this
// assumes this process runs in a container on the same user-defined network
// as containerName, which holds for a docker-compose-managed deployment but
// not every embedder of this package. AGENT_CLIENT_MCP_ADVERTISE_HOST
// overrides it for setups where that assumption doesn't hold (e.g. the host
// process runs on bare metal, or the target container is on a different
// network).
export function containerReachableMcpUrl(url: string): string {
  const host = process.env.AGENT_CLIENT_MCP_ADVERTISE_HOST || hostname()
  return url.replace('127.0.0.1', host)
}
