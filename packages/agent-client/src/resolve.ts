// Client-safe by contract: client components import the provider and adapter
// lookups below, so nothing here may import a node builtin at the top level —
// the bundler externalizes it and the page fails at runtime on first access.
// Anything needing one belongs in its own module (see mcp-url.ts).

import { AGENT_PROVIDERS, type AgentProvider } from './agent-providers'
import { checkEndpointHeaders, headerLines } from './endpoint-headers'
import { type BypassRoute, HARNESS_ADAPTERS, type HarnessAdapter } from './harness-adapters'
import type { AgentSelection, NativeApi, SpawnConfig } from './types'

export function findProvider(id: string): AgentProvider | undefined {
  return AGENT_PROVIDERS.find((provider) => provider.id === id)
}

export function findAdapter(id: string): HarnessAdapter | undefined {
  return HARNESS_ADAPTERS.find((adapter) => adapter.id === id)
}

// Whether the harness sends a selection's request headers to its endpoint
// (HarnessAdapter.endpointHeaders). A host offers headers only where this holds.
export function takesEndpointHeaders(adapterId: string): boolean {
  return Boolean(findAdapter(adapterId)?.endpointHeaders)
}

const BYPASS_BY_MODE: BypassRoute = { kind: 'mode' }

// How a session on this adapter reaches its bypass: what the adapter declares,
// else the mode route.
export function bypassRouteOf(adapterId: string): BypassRoute {
  return findAdapter(adapterId)?.bypass ?? BYPASS_BY_MODE
}

// Whether a selection runs in-process rather than as an ACP subprocess.
// Stated once here because several callers branch on it -- the engine when it
// picks a connection, the fork path, and the independent chat completions --
// and an adapter table that grew a second native harness would otherwise leave
// them disagreeing about what "native" means.
export function isNativeSelection(selection: AgentSelection): boolean {
  return findAdapter(selection.adapterId)?.kind === 'native'
}

export const NATIVE_API_LABELS: Record<NativeApi, string> = {
  'chat-completions': 'Chat Completions',
  responses: 'Responses',
  'anthropic-messages': 'Anthropic Messages',
}

// The APIs the in-process harness can reach a provider through, in the order
// it prefers them when the selection names none: one per endpoint type the
// provider lists, by the rule `adapterOffered` applies to the ACP harnesses
// speaking each (Responses on an OpenAI-compatible endpoint only with the
// selection's opt-in). Chat Completions first, so a selection that names no
// API runs on Chat Completions wherever the provider has it.
export function nativeApisOffered(
  provider: Pick<AgentProvider, 'endpoints'>,
  selection?: Pick<AgentSelection, 'responsesApi'>,
): NativeApi[] {
  const { endpoints } = provider
  const apis: NativeApi[] = []
  if (endpoints.openai !== undefined) {
    apis.push('chat-completions')
  }
  if (
    endpoints['openai-responses'] !== undefined ||
    (endpoints.openai !== undefined && selection?.responsesApi === true)
  ) {
    apis.push('responses')
  }
  if (endpoints.anthropic !== undefined) {
    apis.push('anthropic-messages')
  }
  return apis
}

// The API a native selection runs on: the one it names when its provider
// offers it; else Chat Completions when the selection has a Base URL; else the
// first the provider offers; undefined when the provider offers none. A Base
// URL with no API named is a Chat Completions endpoint whatever the provider
// lists, so a stored profile's Base URL keeps one meaning: a profile on the
// Anthropic provider pointing at an OpenAI-compatible server stays on Chat
// Completions, and naming an API is how a Base URL reaches Responses or
// Messages.
export function nativeApi(
  selection: Pick<AgentSelection, 'providerId' | 'nativeApi' | 'responsesApi' | 'baseUrl'>,
): NativeApi | undefined {
  const provider = findProvider(selection.providerId)
  const offered = provider ? nativeApisOffered(provider, selection) : []
  if (selection.nativeApi && offered.includes(selection.nativeApi)) {
    return selection.nativeApi
  }
  return selection.baseUrl ? 'chat-completions' : offered[0]
}

// Whether an adapter is offered for a provider: the in-process harness where
// the provider offers it an API (`nativeApisOffered`), in-process-protocol
// adapters always; otherwise the provider must list an endpoint of the
// adapter's protocol. A Responses-API-only adapter is also offered on a
// provider with an OpenAI-compatible endpoint when the selection opts in
// (`responsesApi`) — "compatible" says nothing about `/responses`, so it is
// never assumed.
export function adapterOffered(
  adapter: Pick<HarnessAdapter, 'protocol' | 'kind'>,
  provider: Pick<AgentProvider, 'endpoints'>,
  selection?: Pick<AgentSelection, 'responsesApi'>,
): boolean {
  if (adapter.kind === 'native') {
    return nativeApisOffered(provider, selection).length > 0
  }
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
// `harnessHome` when given, else `.harness-home/<id>` inside the agent's
// workdir. Spelled from the workdir rather than left relative: the harness
// does not necessarily run where it was spawned — `npx` started inside a
// package tree runs its command from that package's root (npm 10) — so a
// relative home would land in whatever package encloses the workdir. Relative
// only when there is no workdir to name. A plain string join: this module is
// client-safe (no node:path).
export function harnessHomeDir(
  adapter: Pick<HarnessAdapter, 'id'>,
  selection: Pick<AgentSelection, 'harnessHome'> & Partial<Pick<AgentSelection, 'cwd'>>,
): string {
  const workdir = selection.cwd ? `${selection.cwd.replace(/\/+$/, '')}/` : ''
  const root = selection.harnessHome ? selection.harnessHome.replace(/\/+$/, '') : `${workdir}.harness-home`
  return `${root}/${adapter.id}`
}

/**
 * The model endpoint a selection's harness is pointed at, as buildSpawnConfig
 * hands it over: the selection's Base URL, else the provider's endpoint of the
 * adapter's protocol (the OpenAI-compatible one for a native-protocol
 * harness). Undefined for the in-process harness, and for a harness the
 * selection points at no endpoint (one that reaches its own vendor, such as a
 * subscription).
 */
export function harnessEndpoint(
  selection: Pick<AgentSelection, 'adapterId' | 'providerId' | 'baseUrl'>,
): string | undefined {
  const adapter = findAdapter(selection.adapterId)
  const provider = findProvider(selection.providerId)
  if (!adapter || !provider || adapter.kind === 'native') {
    return undefined
  }
  if (adapter.protocol === 'native') {
    return 'openai' in provider.endpoints ? selection.baseUrl || provider.endpoints.openai || undefined : undefined
  }
  if (!adapter.baseUrlEnv && !adapter.selectionEnv) {
    return undefined
  }
  return selection.baseUrl || provider.endpoints[adapter.protocol] || undefined
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
    for (const [name, subdir] of Object.entries(adapter.homeScopedEnv ?? {})) {
      env[name] = `${home}/${subdir}`
    }
  }
  if (adapter && provider) {
    if (adapter.endpointHeaders) {
      checkEndpointHeaders(selection.headers)
    }
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
      const headersEnv = typeof adapter.endpointHeaders === 'object' ? adapter.endpointHeaders.env : undefined
      if (headersEnv && selection.headers && Object.keys(selection.headers).length) {
        env[headersEnv] = headerLines(selection.headers)
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
    ...(adapter?.scrubEnv?.length ? { unsetEnv: adapter.scrubEnv } : {}),
  }
  const placement = harnessPlacement(selection)
  if (placement.kind === 'shell') {
    return { ...wrapForShell(spawnConfig), shell: placement.shell }
  }
  if (placement.kind === 'container') {
    return wrapInDocker(spawnConfig, placement.container)
  }
  return spawnConfig
}

/**
 * Where a selection's harness runs: on this machine, in a Docker container
 * this machine's `docker` reaches, or through a shell the host provides (by
 * its id). A shell wins over a container name. Every reader of the place asks
 * here.
 */
export type HarnessPlacement =
  | { kind: 'host' }
  | { kind: 'container'; container: string }
  | { kind: 'shell'; shell: string }

export function harnessPlacement(selection: Pick<AgentSelection, 'containerName' | 'shell'>): HarnessPlacement {
  if (selection.shell) {
    return { kind: 'shell', shell: selection.shell }
  }
  if (selection.containerName) {
    return { kind: 'container', container: selection.containerName }
  }
  return { kind: 'host' }
}

/** How a placement is named in a message: "container 'x'", "shell 'y'", "this server". */
export function placementLabel(placement: HarnessPlacement): string {
  switch (placement.kind) {
    case 'shell':
      return `shell '${placement.shell}'`
    case 'container':
      return `container '${placement.container}'`
    default:
      return 'this server'
  }
}

// The environment a host spawn runs with: the host's own, less what the
// adapter scrubs (see HarnessAdapter.scrubEnv), under the spawn's own.
export function spawnEnvironment(
  inherited: Record<string, string | undefined>,
  config: Pick<SpawnConfig, 'env' | 'unsetEnv'>,
): Record<string, string | undefined> {
  const env = { ...inherited }
  for (const name of Object.keys(env)) {
    if (envNameMatches(name, config.unsetEnv ?? [])) {
      delete env[name]
    }
  }
  return { ...env, ...config.env }
}

function envNameMatches(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
}

// A `sh` step that unsets, inside the container, every variable matching the
// patterns except those the spawn forwards itself. The container's variables
// are not known on the host, so they are listed in the container (`env`) and
// filtered there; a line of a multi-line value that happens to look like a
// matching name only unsets a variable that is not set.
function unsetStep(patterns: string[], kept: string[]): string {
  const alternatives = patterns.map((pattern) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(pattern)) {
      throw new Error(`Not an environment variable name or prefix: ${pattern}`)
    }
    return pattern.endsWith('*') ? `${pattern.slice(0, -1)}[A-Za-z0-9_]*` : pattern
  })
  const unset = kept.length ? `case "$v" in ${kept.join('|')}) ;; *) unset "$v" ;; esac` : 'unset "$v"'
  return `for v in $(env | cut -d= -f1 | grep -E '^(${alternatives.join('|')})$'); do ${unset}; done`
}

// The argv that runs a host spawn config's harness in a place of its own (a
// container, a shell elsewhere), started by that place's own shell. The
// per-agent workdir may not exist there yet, so it's created and entered
// before exec'ing the harness (which then inherits the stdio pipes directly).
// Directories the harness needs are paths there, so they are created there —
// after entering the workdir, which is what a relative one is relative to —
// and never on the host.
function placedArgv(config: SpawnConfig): string[] {
  const dir = shellQuote(config.cwd)
  const scrubbed = config.unsetEnv ?? []
  const forwarded = Object.keys(config.env).filter((name) => envNameMatches(name, scrubbed))
  const steps = [
    ...(scrubbed.length ? [unsetStep(scrubbed, forwarded)] : []),
    ...(config.cwd ? [`mkdir -p ${dir}`, `cd ${dir}`] : []),
    ...(config.ensureDirs?.length ? [`mkdir -p ${config.ensureDirs.map(shellQuote).join(' ')}`] : []),
  ]
  return steps.length
    ? ['sh', '-c', `${steps.join(' && ')} && exec "$0" "$@"`, config.command, ...config.args]
    : [config.command, ...config.args]
}

// Rewrap a host spawn config to run the harness inside a Docker container via
// `docker exec`. Env vars are forwarded by name (`-e NAME`) so their values stay
// out of the argv.
function wrapInDocker(config: SpawnConfig, container: string): SpawnConfig {
  const envFlags = Object.keys(config.env).flatMap((name) => ['-e', name])
  return {
    command: 'docker',
    args: ['exec', '-i', ...envFlags, container, ...placedArgv(config)],
    // The docker client runs on the host; the container workdir is set above.
    cwd: '',
    env: config.env,
  }
}

// Rewrap a host spawn config to run the harness through the selection's
// shell: the same argv a container gets, started by the shell, which carries
// `env` its own way.
function wrapForShell(config: SpawnConfig): SpawnConfig {
  const [command, ...args] = placedArgv(config)
  return { command, args, cwd: '', env: config.env }
}

// Single-quote a value for safe embedding in a `sh -c` script.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
