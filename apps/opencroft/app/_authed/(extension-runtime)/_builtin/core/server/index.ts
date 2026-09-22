import type { ExecOptions, ServerConfig, TerminalContext } from '@opencroft/server'
import host from '@opencroft/server'
import { AGENT_PROVIDERS } from 'agent-client/agent-providers'
import { HARNESS_ADAPTERS } from 'agent-client/harness-adapters'
import { disconnectOauth, oauthLoginStatus, startOauthLogin, submitOauthCode } from 'agent-client/oauth-login'
import { reasoningEfforts } from 'agent-client/reasoning'

import { routeOutput, TERMINAL_ROUTER_TYPE, type TerminalRouterData } from '../src/nodes/terminal-router-shared'
import {
  keyStoreCopyKeyToWsl,
  keyStoreCreateKey,
  keyStoreDeleteKey,
  keyStoreImportKey,
  keyStoreListKeys,
  keyStoreReadPublicKey,
  keyStoreRemoveKeyFromWsl,
} from './key-store'
import { nodeActions } from './node-actions'
import { type OpenAIChatParams, openaiChat } from './openai'
import { type HandlerRunParams, runHandler, runScript, type ScriptRunParams } from './script'
import { type GenerateSecretOptions, type GenerateSecretResult, secretsStoreGenerate } from './secrets-store'
import { acceptHostKey, hostKeyStatus, installPublicKey, resolvePublicKey } from './ssh-setup'

export { nodeActions }

// ═══════════════════════════════════════════════════════════════════
// Agent profile catalog (agent-client harnesses + providers)
// ═══════════════════════════════════════════════════════════════════

interface AgentCatalog {
  adapters: { id: string; label: string; protocol: string; kind: 'acp' | 'native'; supportsOauthLogin: boolean }[]
  providers: { id: string; label: string; models: string[]; protocols: string[] }[]
}

function listAgentCatalog(): AgentCatalog {
  return {
    adapters: HARNESS_ADAPTERS.map((a) => ({
      id: a.id,
      label: a.label,
      protocol: a.protocol,
      kind: a.kind ?? 'acp',
      supportsOauthLogin: a.supportsOauthLogin ?? false,
    })),
    providers: AGENT_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      protocols: Object.keys(p.endpoints),
    })),
  }
}

// Discover models from an OpenAI-compatible endpoint (`<baseUrl>/models`),
// resolving the agent's API key from the Secrets Store server-side. Mirrors
// agent-client's model discovery so the profile's model list stays live.
async function listModels(params: { baseUrl?: string; apiKeySecret?: string }): Promise<string[]> {
  const base = (params.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) {
    return []
  }
  const key = params.apiKeySecret ? ((await host.secrets.resolve(params.apiKeySecret)) ?? '') : ''
  const headers: Record<string, string> = {}
  if (key) {
    headers.Authorization = `Bearer ${key}`
  }
  const res = await fetch(`${base}/models`, { headers })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { data?: { id?: string }[] }
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id))
    .sort()
}

// TTS capability probe for the agent Speech tab. Reads the endpoint's voice
// presets (`<baseUrl>/audio/voices`) and, when the server exposes an OpenAPI
// schema (FastAPI-style, e.g. VibeVoice), which optional synthesis params its
// `/audio/speech` accepts — so the UI can offer the discovered voices and show
// or disable instructions / temperature / seed to match the endpoint.
interface TtsCapabilities {
  voices: string[]
  supportsInstructions: boolean
  supportsTemperature: boolean
  supportsSeed: boolean
  schemaKnown: boolean
}

// A header entry as stored in the agent node's data (`ttsHeaders`/`asrHeaders`).
interface HeaderPair {
  name: string
  value: string
}

const SECRET_PREFIX = 'secret:'

// `secret:NAME` resolves from the Secrets Store; anything else is sent as
// typed. Resolution happens here, at request time, so a basic-auth password
// never has to sit in the node's data as plain text.
//
// An unresolvable name throws rather than yielding an empty value, matching the
// same convention elsewhere. Empty would send `Authorization: ` and earn a 401,
// leaving the tab with no voices and no knobs — indistinguishable from a broken
// endpoint, which is the confusion this feature exists to remove. The error
// names the secret instead.
async function resolveHeaderValue(value: string): Promise<string> {
  if (!value.startsWith(SECRET_PREFIX)) {
    return value
  }
  const name = value.slice(SECRET_PREFIX.length).trim()
  const resolved = name ? await host.secrets.resolve(name) : null
  if (resolved === null) {
    throw new Error(`Secret "${name}" not found in any Secrets Store`)
  }
  return resolved
}

// Default headers for a speech endpoint, with the node's custom pairs merged
// over them. Shared by every probe here; the audio-pipelines extension applies
// the same rules to the request paths it owns.
async function speechHeaders(apiKey?: string, custom?: HeaderPair[]): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  for (const entry of custom ?? []) {
    const name = entry?.name?.trim()
    if (!name) {
      continue
    }
    // Header names are case-insensitive on the wire but object keys are not,
    // so drop any key differing only in case first. Without this a custom
    // `authorization` would sit alongside the Bearer shorthand instead of
    // replacing it, and the endpoint would receive two conflicting values.
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) {
        delete headers[existing]
      }
    }
    headers[name] = await resolveHeaderValue(entry.value ?? '')
  }
  return headers
}

interface OpenApiSpec {
  paths?: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> } } }>
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
}

function speechRequestProps(spec: OpenApiSpec): Record<string, unknown> | null {
  const paths = spec.paths ?? {}
  const key = Object.keys(paths).find((k) => /audio\/speech\/?$/.test(k))
  if (!key) {
    return null
  }
  const ref = paths[key]?.post?.requestBody?.content?.['application/json']?.schema?.$ref
  if (!ref) {
    return null
  }
  const name = ref.split('/').pop()
  return (name ? spec.components?.schemas?.[name]?.properties : null) ?? null
}

async function ttsCapabilities(params: {
  baseUrl?: string
  apiKey?: string
  headers?: HeaderPair[]
}): Promise<TtsCapabilities> {
  const base = (params.baseUrl ?? '').replace(/\/+$/, '')
  const caps: TtsCapabilities = {
    voices: [],
    supportsInstructions: false,
    supportsTemperature: false,
    supportsSeed: false,
    schemaKnown: false,
  }
  if (!base) {
    return caps
  }
  // Both probes below use these. Without them an authenticated endpoint answers
  // 401 to each, and the tab shows no voices and no knobs — reading as "this
  // endpoint is broken" rather than "these requests were unauthorised".
  const headers = await speechHeaders(params.apiKey, params.headers)

  try {
    const res = await fetch(`${base}/audio/voices`, { headers })
    if (res.ok) {
      const body = (await res.json()) as { data?: { id?: string }[] }
      caps.voices = (body.data ?? []).map((v) => v.id).filter((id): id is string => Boolean(id))
    }
  } catch {
    // no voices endpoint — leave the list empty
  }

  // OpenAPI usually lives at the server root, not under the /v1 base path.
  const candidates: string[] = []
  try {
    candidates.push(`${new URL(base).origin}/openapi.json`)
  } catch {
    // base is not an absolute URL
  }
  candidates.push(`${base}/openapi.json`)
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) {
        continue
      }
      const props = speechRequestProps((await res.json()) as OpenApiSpec)
      if (props) {
        caps.schemaKnown = true
        caps.supportsInstructions = 'instructions' in props
        caps.supportsTemperature = 'temperature' in props
        caps.supportsSeed = 'seed' in props
        break
      }
    } catch {
      // not an OpenAPI endpoint — capabilities stay unknown
    }
  }
  return caps
}

const isWindows = host.os.platform() === 'win32'

// ═══════════════════════════════════════════════════════════════════
// Localhost
// ═══════════════════════════════════════════════════════════════════

interface LocalhostStats {
  os: string
  cpu: string
  memory: string
  storage: string
  hostname: string
  platform: string
}

function formatBytes(b: number): string {
  return `${(b / 1024 ** 3).toFixed(1)}G`
}

async function getLocalhostDiskUsage(): Promise<string> {
  if (isWindows) {
    try {
      const stdout = await host.execFile('wmic', [
        'logicaldisk',
        'where',
        'DeviceID="C:"',
        'get',
        'Size,FreeSpace',
        '/format:csv',
      ])
      const lines = stdout.trim().split('\n').filter(Boolean)
      const last = lines[lines.length - 1]
      const parts = last.split(',')
      const free = parseInt(parts[1] || '0', 10)
      const total = parseInt(parts[2] || '0', 10)
      const used = total - free
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(0)}G`
      return `${gb(used)}/${gb(total)}`
    } catch {
      return 'unknown'
    }
  }
  try {
    const stdout = await host.execFile('df', ['-h', '/'])
    const lines = stdout.trim().split('\n')
    const parts = lines[1]?.split(/\s+/)
    return parts ? `${parts[2]}/${parts[1]}` : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function getLocalhostStats(): Promise<LocalhostStats> {
  const cpus = host.os.cpus()
  const totalMem = host.os.totalmem()
  const freeMem = host.os.freemem()
  return {
    os: `${host.os.type()} ${host.os.release()}`,
    cpu: `${cpus.length}x ${cpus[0]?.model || host.os.arch()}`,
    memory: `${formatBytes(totalMem - freeMem)}/${formatBytes(totalMem)}`,
    storage: await getLocalhostDiskUsage(),
    hostname: host.os.hostname(),
    platform: host.os.platform(),
  }
}

// ═══════════════════════════════════════════════════════════════════
// WSL
// ═══════════════════════════════════════════════════════════════════

interface WslStats {
  os: string
  cpu: string
  memory: string
  storage: string
}

async function getWslStats(distro: string): Promise<WslStats> {
  if (!isWindows) {
    return { os: 'unavailable', cpu: 'unavailable', memory: 'unavailable', storage: 'unavailable' }
  }
  const script = [
    'echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"',
    'echo "CPU=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo unknown)x $(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || uname -m)"',
    'echo "MEMORY=$(free -h 2>/dev/null | awk \'/^Mem:/{print $3"/"$2}\' || echo unknown)"',
    'echo "STORAGE=$(df -h / 2>/dev/null | awk \'NR==2{print $3"/"$2}\' || echo unknown)"',
  ].join(' && ')
  const out = await host.execFile('wsl', ['-d', distro, '--exec', 'bash', '-c', script])
  const lines: Record<string, string> = {}
  for (const line of out.trim().split('\n')) {
    const [key, ...rest] = line.split('=')
    lines[key] = rest.join('=')
  }
  return {
    os: lines['OS'] || 'unknown',
    cpu: lines['CPU'] || 'unknown',
    memory: lines['MEMORY'] || 'unknown',
    storage: lines['STORAGE'] || 'unknown',
  }
}

// ═══════════════════════════════════════════════════════════════════
// Secrets Store
// ═══════════════════════════════════════════════════════════════════

interface SecretRowOut {
  id: string
  key: string
  value: string
  updatedAt: string
}

async function secretsStoreGetSecrets(storeId: string): Promise<SecretRowOut[]> {
  const rows = await host.secrets.list(storeId)
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: r.value,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

async function secretsStoreSetSecret(storeId: string, key: string, value: string): Promise<void> {
  await host.secrets.set(storeId, key, value)
}

async function secretsStoreDeleteSecret(storeId: string, key: string): Promise<void> {
  await host.secrets.delete(storeId, key)
}

async function secretsStoreRotateSecret(storeId: string, key: string): Promise<string> {
  const value = host.crypto.randomToken()
  await host.secrets.set(storeId, key, value)
  return value
}

interface OrphanRow {
  id: string
  storeId: string
  key: string
  updatedAt: string
}

async function secretsStoreListOrphans(currentStoreId: string): Promise<OrphanRow[]> {
  const rows = await host.secrets.listAll()
  return rows
    .filter((r) => r.storeId !== currentStoreId)
    .map((r) => ({
      id: r.id,
      storeId: r.storeId,
      key: r.key,
      updatedAt: r.updatedAt.toISOString(),
    }))
}

async function secretsStoreDeleteOrphan(id: string): Promise<void> {
  await host.secrets.deleteById(id)
}

// ═══════════════════════════════════════════════════════════════════
// Server stats
// ═══════════════════════════════════════════════════════════════════

interface ServerStats {
  os: string
  cpu: string
  memory: string
  storage: string
}

// ═══════════════════════════════════════════════════════════════════
// Terminal exec (with optional cwd/env opts) — routes through execResult so
// both reach the backend properly (cwd via ExecOptions.cwd, env via the
// backend's own out-of-band injection) instead of a hand-built `cd ... &&`
// string that had no equivalent way to carry env at all.
// ═══════════════════════════════════════════════════════════════════

/**
 * Run a command and return its stdout alongside whether the backend cut that stdout at its
 * output cap. Same failure contract as `terminal.exec` — a non-zero exit throws — but the
 * caller also learns that what it received is incomplete.
 *
 * The cap truncates rather than erroring, so without this the loss is invisible: a string that
 * was cut is indistinguishable from a command that simply produced that much. Every caller
 * returning command output to a reader wants this; `terminal.exec` remains for the ones that
 * only care about the text.
 */
async function terminalExecDetailed(
  ctx: TerminalContext,
  command: string,
  opts?: ExecOptions,
): Promise<{ stdout: string; truncated: boolean }> {
  const result = await host.terminal.execResult(ctx, command, opts)
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? ' (timed out)' : ''
    const suffix = result.stderr ? `: ${result.stderr}` : ''
    throw new Error(`Command exited with code ${result.exitCode}${detail}${suffix}`)
  }
  return { stdout: result.stdout, truncated: result.stdoutTruncated === true }
}

// Delegates so the failure contract lives in exactly one place — the two must never disagree
// about what a non-zero exit means.
async function terminalExecWithOpts(ctx: TerminalContext, command: string, opts?: ExecOptions): Promise<string> {
  return (await terminalExecDetailed(ctx, command, opts)).stdout
}

async function serverGetStats(config: ServerConfig): Promise<ServerStats> {
  const script = [
    'echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"',
    'echo "CPU=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo unknown)x $(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || uname -m)"',
    'echo "MEMORY=$(free -h 2>/dev/null | awk \'/^Mem:/{print $3"/"$2}\' || echo unknown)"',
    'echo "STORAGE=$(df -h / 2>/dev/null | awk \'NR==2{print $3"/"$2}\' || echo unknown)"',
  ].join(' && ')
  const out = await host.ssh.exec(config, script)
  const lines: Record<string, string> = {}
  for (const line of out.trim().split('\n')) {
    const [key, ...rest] = line.split('=')
    lines[key] = rest.join('=')
  }
  return {
    os: lines['OS'] || 'unknown',
    cpu: lines['CPU'] || 'unknown',
    memory: lines['MEMORY'] || 'unknown',
    storage: lines['STORAGE'] || 'unknown',
  }
}

// ═══════════════════════════════════════════════════════════════════
// Action registry
// ═══════════════════════════════════════════════════════════════════

// "node-id/handle-id", split at the first slash like every other target consumer.
async function resolveRouteTarget(target: string): Promise<TerminalContext> {
  const slash = target.indexOf('/')
  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`Not a terminal target: "${target}" (expected "node-id/handle-id")`)
  }
  return host.terminal.getContext(target.slice(0, slash), target.slice(slash + 1))
}

export const actions = {
  'localhost.getStats': () => getLocalhostStats(),
  'wsl.getStats': (distro: string) => getWslStats(distro),
  'keyStore.listKeys': (storeId: string) => keyStoreListKeys(storeId),
  'keyStore.createKey': (storeId: string, name: string, keyType: string) => keyStoreCreateKey(storeId, name, keyType),
  'keyStore.importKey': (storeId: string, name: string, content: string) => keyStoreImportKey(storeId, name, content),
  'keyStore.deleteKey': (storeId: string, name: string) => keyStoreDeleteKey(storeId, name),
  'keyStore.readPublicKey': (storeId: string, name: string) => keyStoreReadPublicKey(storeId, name),
  'keyStore.copyKeyToWsl': (storeId: string, name: string) => keyStoreCopyKeyToWsl(storeId, name),
  'keyStore.removeKeyFromWsl': (name: string) => keyStoreRemoveKeyFromWsl(name),
  'secretsStore.getSecrets': (storeId: string) => secretsStoreGetSecrets(storeId),
  'secretsStore.setSecret': (storeId: string, key: string, value: string) => secretsStoreSetSecret(storeId, key, value),
  'secretsStore.deleteSecret': (storeId: string, key: string) => secretsStoreDeleteSecret(storeId, key),
  'secretsStore.rotateSecret': (storeId: string, key: string) => secretsStoreRotateSecret(storeId, key),
  'secretsStore.generate': (
    storeId: string,
    name: string,
    options?: GenerateSecretOptions,
  ): Promise<GenerateSecretResult> => secretsStoreGenerate(storeId, name, options),
  'secretsStore.listOrphans': (storeId: string) => secretsStoreListOrphans(storeId),
  'secretsStore.deleteOrphan': (id: string) => secretsStoreDeleteOrphan(id),
  'server.getStats': (config: ServerConfig) => serverGetStats(config),
  'server.resolveKey': (keyPath: string) => host.ssh.resolveKey(keyPath),
  'server.hostKeyStatus': (address: string, port: number) => hostKeyStatus(address, port),
  'server.acceptHostKey': (address: string, port: number) => acceptHostKey(address, port),
  'server.installKey': async (config: ServerConfig, keyRef: string) =>
    installPublicKey(config, await resolvePublicKey(keyRef)),
  'terminal.run': (ctx: TerminalContext, args: string[]) => host.terminal.run(ctx, args),
  // A Terminal Router route's context at the moment it is added (see the node's inspector).
  'terminalRouter.resolve': (target: string) => resolveRouteTarget(String(target ?? '')),
  'terminal.exec': (ctx: TerminalContext, command: string, opts?: ExecOptions) =>
    terminalExecWithOpts(ctx, command, opts),
  'terminal.execDetailed': (ctx: TerminalContext, command: string, opts?: ExecOptions) =>
    terminalExecDetailed(ctx, command, opts),
  'script.run': (params: ScriptRunParams) => runScript(params),
  'handler.run': (params: HandlerRunParams) => runHandler(params),
  'openai.chat': (params: OpenAIChatParams) => openaiChat(params),
  'agent.listAgentCatalog': () => listAgentCatalog(),
  'agent.listModels': (params: { baseUrl?: string; apiKeySecret?: string }) => listModels(params),
  // Computed per-model on demand (not baked into listAgentCatalog) so it also
  // covers models discovered from an OpenAI-compatible endpoint or typed in by
  // hand, not just the static AGENT_PROVIDERS catalog.
  'agent.reasoningEfforts': (model: string) => reasoningEfforts(String(model ?? '')),
  'agent.oauthStatus': (adapterId: string) => oauthLoginStatus(String(adapterId ?? '')),
  'agent.oauthStart': (adapterId: string) => startOauthLogin(String(adapterId ?? '')),
  'agent.oauthSubmitCode': (params: { loginId?: string; code?: string }) =>
    submitOauthCode(String(params?.loginId ?? ''), String(params?.code ?? '')),
  'agent.oauthDisconnect': (adapterId: string) => disconnectOauth(String(adapterId ?? '')),
  'tts.capabilities': (params: { baseUrl?: string; apiKey?: string; headers?: HeaderPair[] }) =>
    ttsCapabilities(params),
}

// ═══════════════════════════════════════════════════════════════════
// exposeOutput
// ═══════════════════════════════════════════════════════════════════

export const exposeOutput = (handleId: string, nodeData: Record<string, unknown>, typeId: string): unknown => {
  if (typeId === TERMINAL_ROUTER_TYPE) {
    return routeOutput(handleId, nodeData as TerminalRouterData)
  }

  if (typeId === 'localhost') {
    if (handleId === 'terminal' || handleId === 'fs-out') {
      return { type: 'local' }
    }
    return undefined
  }

  if (typeId === 'wsl') {
    const distro = nodeData.distro as string | undefined
    if (!distro) {
      return undefined
    }
    if (handleId === 'terminal' || handleId === 'fs-out') {
      return { type: 'wsl', distro }
    }
    return undefined
  }

  if (typeId === 'server') {
    const address = nodeData.address as string | undefined
    if (!address) {
      return undefined
    }
    if (handleId === 'terminal' || handleId === 'fs-out') {
      return {
        type: 'ssh',
        host: address,
        port: (nodeData.port as number) || 22,
        username: (nodeData.username as string) || 'root',
        password: nodeData.password as string | undefined,
        keyPath: nodeData.keyPath as string | undefined,
      }
    }
    return undefined
  }

  return undefined
}
