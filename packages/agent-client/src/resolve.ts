// Client-safe by contract: client components import the provider and adapter
// lookups below, so nothing here may import a node builtin at the top level —
// the bundler externalizes it and the page fails at runtime on first access.
// Anything needing one belongs in its own module (see mcp-url.ts).

import { AGENT_PROVIDERS, type AgentProvider } from './agent-providers'
import { HARNESS_ADAPTERS, type HarnessAdapter } from './harness-adapters'
import type { AgentSelection, SpawnConfig } from './types'

export function findProvider(id: string): AgentProvider | undefined {
  return AGENT_PROVIDERS.find((provider) => provider.id === id)
}

export function findAdapter(id: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((adapter) => adapter.id === id)
}

// Whether a selection runs in-process rather than as an ACP subprocess.
// Stated once here because several callers branch on it -- the engine when it
// picks a connection, the fork path, and the independent chat completions --
// and an adapter table that grew a second native harness would otherwise leave
// them disagreeing about what "native" means.
export function isNativeSelection(selection: AgentSelection): boolean {
  return findAdapter(selection.adapterId)?.kind === 'native'
}

// Whether an adapter is offered for a provider: in-process-protocol adapters
// always; otherwise the provider must list an endpoint of the adapter's
// protocol. A Responses-API-only adapter is also offered on a provider with an
// OpenAI-compatible endpoint when the selection opts in (`responsesApi`) —
// "compatible" says nothing about `/responses`, so it is never assumed.
export function adapterOffered(
  adapter: Pick<HarnessAdapter, 'protocol'>,
  provider: Pick<AgentProvider, 'endpoints'>,
  selection?: Pick<AgentSelection, 'responsesApi'>,
): boolean {
  if (adapter.protocol === 'native' || provider.endpoints[adapter.protocol] !== undefined) {
    return true
  }
  return (
    adapter.protocol === 'openai-responses' &&
    provider.endpoints.openai !== undefined &&
    selection?.responsesApi === true
  )
}

export function adaptersForProvider(
  providerId: string,
  selection?: Pick<AgentSelection, 'responsesApi'>,
): HarnessAdapter[] {
  const provider = findProvider(providerId)
  if (!provider) {
    return []
  }
  return HARNESS_ADAPTERS.filter((adapter) => adapterOffered(adapter, provider, selection))
}

// Whether a provider could offer Responses-API-only harnesses given the opt-in:
// it has an OpenAI-compatible endpoint but no Responses endpoint of its own.
// Forms show the "supports the Responses API" switch only then.
export function responsesApiOptIn(provider: Pick<AgentProvider, 'endpoints'> | undefined): boolean {
  return Boolean(
    provider && provider.endpoints.openai !== undefined && provider.endpoints['openai-responses'] === undefined,
  )
}

// The harness home an adapter with `homeEnv` is pointed at: the host-owned
// `harnessHome` when given, else `.harness-home/<id>` RELATIVE to the agent's
// workdir — the harness resolves a relative home against the directory it was
// started in, and ensureDirs are created against that same directory. A plain
// string join: this module is client-safe (no node:path).
export function harnessHomeDir(
  adapter: Pick<HarnessAdapter, 'id'>,
  selection: Pick<AgentSelection, 'harnessHome'>,
): string {
  const root = selection.harnessHome ? selection.harnessHome.replace(/\/+$/, '') : '.harness-home'
  return `${root}/${adapter.id}`
}

export function buildSpawnConfig(selection: AgentSelection): SpawnConfig {
  const adapter = findAdapter(selection.adapterId)
  const provider = findProvider(selection.providerId)
  const env: Record<string, string> = {}

  const ensureDirs: string[] = []

  if (adapter?.staticEnv) {
    Object.assign(env, adapter.staticEnv)
  }
  if (adapter?.homeEnv) {
    const home = harnessHomeDir(adapter, selection)
    env[adapter.homeEnv] = home
    ensureDirs.push(home)
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
    // Provider wiring that cannot travel through the vars above — a config
    // document of the harness's own, carried in one env var — is built by the
    // adapter itself (see selectionEnv in harness-adapters).
    if (adapter.selectionEnv) {
      Object.assign(env, adapter.selectionEnv(provider, selection, keyEnv))
    }
  }

  const spawnConfig: SpawnConfig = {
    command: adapter?.command ?? 'npx',
    args: adapter?.args ?? [],
    cwd: selection.cwd,
    env,
    ...(ensureDirs.length ? { ensureDirs } : {}),
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
  // Directories the harness needs are container paths, so they are created in
  // the container — after entering the workdir, which is what a relative one
  // is relative to — and never on the host.
  const steps = [
    ...(config.cwd ? [`mkdir -p ${dir}`, `cd ${dir}`] : []),
    ...(config.ensureDirs?.length ? [`mkdir -p ${config.ensureDirs.map(shellQuote).join(' ')}`] : []),
  ]
  const inner = steps.length
    ? ['sh', '-c', `${steps.join(' && ')} && exec "$0" "$@"`, config.command, ...config.args]
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
