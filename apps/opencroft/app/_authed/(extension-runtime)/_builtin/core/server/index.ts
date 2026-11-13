import { agentInstructions } from '@opencroft/server/agents'
import { extensionId } from '@opencroft/server/extension'
import { graph, type NodeCheckInstance, type NodeChecks, type NodeDataValidators } from '@opencroft/server/graph'
import { mcpTokens } from '@opencroft/server/people'
import { type SecretRecipe, type SecretScope, secrets } from '@opencroft/server/secrets'
import { execFile, os, path } from '@opencroft/server/system'
import {
  agentRefusalOf,
  type ExecOptions,
  execContext,
  type GraphCallTarget,
  type ServerConfig,
  ssh,
  type TerminalContext,
  terminal,
} from '@opencroft/server/terminal'
import { type EnumCasesOf, NO_ENUMS } from '@opencroft/server/values'
import { AGENT_PROVIDERS } from 'agent-client/agent-providers'
import { HARNESS_ADAPTERS } from 'agent-client/harness-adapters'
import { placedShell } from 'agent-client/harness-process'
import {
  endpointReach,
  endpointReachMessage,
  missingLauncherCommands,
  missingLauncherMessage,
} from 'agent-client/launcher-check'
import {
  awaitOauthLogin,
  disconnectOauth,
  type OauthPlacement,
  oauthLoginStatus,
  startOauthLogin,
  submitOauthCode,
} from 'agent-client/oauth-login'
import { reasoningEfforts } from 'agent-client/reasoning'
import { harnessEndpoint, takesEndpointHeaders } from 'agent-client/resolve'
import type { RemoteShell } from 'agent-client/types'

import { type HeaderPair, resolveHeaders } from '../src/nodes/agent-headers-shared'
import {
  AGENT_PLACEMENT_ERROR_SOURCE,
  agentPlacement,
  agentTerminalShell,
  FolderMissingError,
  placementOnTerminal,
} from '../src/nodes/agent-placement-shared'
import { apiRouteDataProblems } from '../src/nodes/api-route-protection'
import { CALL_ACTION, callActionOutputValue } from '../src/nodes/call-action-shared'
import { RUN_OUTPUTS, runOutputValue } from '../src/nodes/run-outputs'
import { scriptDataProblems } from '../src/nodes/script-language'
import { storedType } from '../src/nodes/stored-type'
import { portValueOf } from '../src/nodes/subgraph-shared'
import {
  routeOutput,
  routeTarget,
  routeToRouteText,
  TERMINAL_ROUTER_TYPE,
  type TerminalRouteResolution,
  type TerminalRouterData,
  targetNodeId,
} from '../src/nodes/terminal-router-shared'
import {
  bareValueNodeType,
  VALUE_NODE,
  type ValueNodeType,
  valueNodeCheck,
  valueNodeDataProblems,
  valueNodeExposed,
} from '../src/nodes/value-nodes-shared'
import { apiRouteCheck } from './api-route-check'
import { shownOverride } from './checked-delete'
import {
  keyStoreCopyKeyToWsl,
  keyStoreCreateKey,
  keyStoreDeleteKey,
  keyStoreHasWsl,
  keyStoreImportKey,
  keyStoreReadPublicKey,
  keyStoreReferences,
  keyStoreRemoveKeyFromWsl,
  keyStoreShowKeys,
} from './key-store'
import { nodeActions } from './node-actions'
import { type HandlerRunParams, runHandler, runScript, type ScriptRunParams } from './script'
import { orphanRows, refuseOrphanDelete } from './secret-orphans'
import { canRotate } from './secret-recipes'
import {
  type GenerateSecretOptions,
  type GenerateSecretResult,
  secretsStoreDelete,
  secretsStoreGenerate,
  secretsStoreReferences,
  secretsStoreRename,
  secretsStoreRotate,
  secretsStoreSet,
  secretsStoreSetPassword,
} from './secrets-store'
import { acceptHostKey, hostKeyStatus, installPublicKey, resolvePublicKey } from './ssh-setup'
import { terminalRouterCheck } from './terminal-router-check'

export { nodeActions }

const VALUE_NODE_TYPES: ValueNodeType[] = Object.values(VALUE_NODE)

export const nodeDataValidators = {
  'api-route': apiRouteDataProblems,
  'script-bash': scriptDataProblems,
  'script-python': scriptDataProblems,
  'script-node': scriptDataProblems,
  ...Object.fromEntries(
    VALUE_NODE_TYPES.map((type) => [type, (data: Record<string, unknown>) => valueNodeDataProblems(type, data)]),
  ),
} satisfies NodeDataValidators

export const nodeChecks = {
  'api-route': apiRouteCheck,
  [TERMINAL_ROUTER_TYPE]: terminalRouterCheck,
  ...Object.fromEntries(
    VALUE_NODE_TYPES.map((type) => [
      type,
      (node: { data: Record<string, unknown> }, _edges: unknown, instance: NodeCheckInstance) =>
        valueNodeCheck(type, node.data, instance.enumCasesOf),
    ]),
  ),
} satisfies NodeChecks

// ═══════════════════════════════════════════════════════════════════
// Agent profile catalog (agent-client harnesses + providers)
// ═══════════════════════════════════════════════════════════════════

interface AgentCatalog {
  adapters: {
    id: string
    label: string
    protocol: string
    kind: 'acp' | 'native'
    supportsOauthLogin: boolean
    takesEndpointHeaders: boolean
  }[]
  providers: { id: string; label: string; models: string[] }[]
}

function listAgentCatalog(): AgentCatalog {
  return {
    adapters: HARNESS_ADAPTERS.map((a) => ({
      id: a.id,
      label: a.label,
      protocol: a.protocol,
      kind: a.kind ?? 'acp',
      supportsOauthLogin: a.supportsOauthLogin ?? false,
      takesEndpointHeaders: takesEndpointHeaders(a.id),
    })),
    providers: AGENT_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
    })),
  }
}

// Where an agent's harness login lives: the harness home and container its
// sessions are spawned with. A harness that keeps its login in that home
// (Codex) reads it from there and nowhere else, so a sign-in, a status check
// or a disconnect aimed anywhere else would act on a login the agent never sees.
async function agentOauthPlacement(nodeId: string): Promise<OauthPlacement> {
  const node = await graph.getNode(String(nodeId ?? ''))
  if (node?.type !== storedType(extensionId, 'agent')) {
    throw new Error('Agent node not found')
  }
  const placement = agentPlacement(
    node.data as { name?: string; terminal?: string; terminalFolder?: string },
    node.id,
    { cwd: process.cwd(), join: path.join },
  )
  if (!placement.terminal) {
    return { harnessHome: placement.harnessHome }
  }
  const shell = terminalShell(placement.terminal)
  const placed = await placementOnTerminal(placement, shellRunner(shell), (await shell.describe?.()) ?? 'its terminal')
  return { harnessHome: placed.harnessHome, shell }
}

function shellRunner(shell: RemoteShell) {
  return placedShell({ kind: 'shell', shell: shell.id }, (id) => (id === shell.id ? shell : undefined))
}

// The shell an agent runs through on the terminal `target`, built the way the
// session engine builds it. Used for a sign-in and a launcher check, which run
// no session, so nothing asks it for an MCP address.
function terminalShell(target: string) {
  return agentTerminalShell(
    target,
    { getContext: terminal.getContext, agentRefusalOf, spawn: terminal.spawn },
    (url) => url,
  )
}

export interface TerminalCheck {
  // The directory the agent works in there: its Folder, or the terminal's
  // own directory when Folder is empty. Absent when the Folder is missing.
  workdir?: string
  // That the Folder is not a directory on the terminal, in a sentence.
  folderProblem?: string
  // What the harness lacks on the terminal's PATH, in a sentence; absent when
  // nothing is missing.
  problem?: string
  // Whether the profile's model endpoint answers from the terminal; absent
  // when the profile points the harness at no endpoint, or Node is missing.
  endpoint?: { reachable: boolean; message: string }
  // Why the terminal could not be asked at all.
  error?: string
}

// Whether the harness an agent profile picks could start on the terminal
// `target`, asked through the same shell the session engine starts it in:
// the directory it would work in (the Folder, which must exist there, or the
// terminal's own), the `command -v` probe the engine runs before starting it,
// then whether the profile's model endpoint answers from there (an
// unauthenticated request with that machine's Node). Nothing is installed,
// written or left running on the far side, and no key is sent.
async function checkAgentTerminal(params: {
  nodeId?: string
  terminal?: string
  folder?: string
  adapterId?: string
  providerId?: string
  baseUrl?: string
}): Promise<TerminalCheck> {
  const target = String(params.terminal ?? '')
  if (!target.includes('/')) {
    return { error: 'No terminal is selected.' }
  }
  if (params.nodeId) {
    // With a terminal picked, the error the placement move left on an agent
    // it could not move (placement-migration.ts) no longer holds.
    await graph.setNodeErrors(String(params.nodeId), AGENT_PLACEMENT_ERROR_SOURCE, [])
  }
  const adapterId = String(params.adapterId || 'claude')
  const shell = terminalShell(target)
  try {
    const run = shellRunner(shell)
    const placement = agentPlacement({ terminal: target, terminalFolder: String(params.folder ?? '') }, '', {
      cwd: process.cwd(),
      join: path.join,
    })
    const workdir = await placementOnTerminal(placement, run, 'this terminal').then(
      (placed) => ({ workdir: placed.cwd }),
      (error: unknown) => {
        if (error instanceof FolderMissingError) {
          return { folderProblem: error.message }
        }
        throw error
      },
    )
    const missing = await missingLauncherCommands(run, adapterId)
    if (missing.length) {
      return { ...workdir, problem: missingLauncherMessage(missing, 'this terminal') }
    }
    const url = harnessEndpoint({
      adapterId,
      providerId: String(params.providerId ?? ''),
      baseUrl: params.baseUrl ? String(params.baseUrl) : undefined,
    })
    if (!url) {
      return workdir
    }
    const reach = await endpointReach(run, url)
    return {
      ...workdir,
      endpoint: { reachable: reach.reachable, message: endpointReachMessage(url, reach, 'this terminal') },
    }
  } catch (error) {
    return { error: `The terminal could not be checked: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// Discover models from an OpenAI-compatible endpoint (`<baseUrl>/models`),
// resolving the agent's API key and request headers server-side from the
// Secrets Stores on the agent node's graph. Mirrors agent-client's model
// discovery so the profile's model list stays live. `headers` are the ones the
// Profile tab shows, so the list is read with what the sessions will send.
async function listModels(params: {
  nodeId?: string
  baseUrl?: string
  apiKeySecret?: string
  headers?: HeaderPair[]
}): Promise<string[]> {
  const base = (params.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) {
    return []
  }
  const scope = { nodeId: String(params.nodeId ?? '') }
  const key = params.apiKeySecret ? ((await secrets.resolve(params.apiKeySecret, scope)) ?? '') : ''
  const headers = await resolveHeaders(
    params.headers,
    (value) => secrets.resolveValue(value, scope),
    key ? { Authorization: `Bearer ${key}` } : {},
  )
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

// Default headers for a speech endpoint, with the node's custom pairs merged
// over them. Shared by every probe here; the audio-pipelines extension applies
// the same rules to the request paths it owns.
//
// The key and every header value are typed text or `secret:NAME`, resolved
// here, at request time, from the Secrets Stores on the agent node's graph, so
// a credential never has to sit in the node's data as plain text. An
// unresolvable name throws rather than sending a blank `Authorization`, which
// would earn a 401 and leave the tab with no voices and no knobs,
// indistinguishable from a broken endpoint. The error names the secret instead.
async function speechHeaders(
  scope: SecretScope,
  apiKey?: string,
  custom?: HeaderPair[],
): Promise<Record<string, string>> {
  const resolveValue = (value: string) => secrets.resolveValue(value, scope)
  return resolveHeaders(
    custom,
    resolveValue,
    apiKey?.trim() ? { Authorization: `Bearer ${await resolveValue(apiKey)}` } : {},
  )
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
  nodeId?: string
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
  const headers = await speechHeaders({ nodeId: String(params.nodeId ?? '') }, params.apiKey, params.headers)

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

const isWindows = os.platform() === 'win32'

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
      const stdout = await execFile('wmic', [
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
    const stdout = await execFile('df', ['-h', '/'])
    const lines = stdout.trim().split('\n')
    const parts = lines[1]?.split(/\s+/)
    return parts ? `${parts[2]}/${parts[1]}` : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function getLocalhostStats(): Promise<LocalhostStats> {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  return {
    os: `${os.type()} ${os.release()}`,
    cpu: `${cpus.length}x ${cpus[0]?.model || os.arch()}`,
    memory: `${formatBytes(totalMem - freeMem)}/${formatBytes(totalMem)}`,
    storage: await getLocalhostDiskUsage(),
    hostname: os.hostname(),
    platform: os.platform(),
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
  const out = await execFile('wsl', ['-d', distro, '--exec', 'bash', '-c', script])
  const lines: Record<string, string> = {}
  for (const line of out.trim().split('\n')) {
    const [key, ...rest] = line.split('=')
    lines[key] = rest.join('=')
  }
  return {
    os: lines.OS || 'unknown',
    cpu: lines.CPU || 'unknown',
    memory: lines.MEMORY || 'unknown',
    storage: lines.STORAGE || 'unknown',
  }
}

// ═══════════════════════════════════════════════════════════════════
// Secrets Store
// ═══════════════════════════════════════════════════════════════════

interface SecretRowOut {
  id: string
  key: string
  value: string
  recipe: SecretRecipe | null
  /** Whether Rotate can make the next value (see `canRotate`). */
  rotatable: boolean
  updatedAt: string
}

async function secretsStoreGetSecrets(storeId: string): Promise<SecretRowOut[]> {
  const rows = await secrets.list(storeId)
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: r.value,
    recipe: r.recipe,
    rotatable: canRotate(r.recipe),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

interface OrphanRow {
  id: string
  storeId: string
  key: string
  updatedAt: string
}

async function secretsStoreListOrphans(storeId: string): Promise<OrphanRow[]> {
  const [rows, stores] = await Promise.all([secrets.listAllKeys(), graph.listNodesByType('core-secrets-store')])
  return orphanRows(storeId, rows, stores).map((r) => ({
    id: r.id,
    storeId: r.storeId,
    key: r.key,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

/**
 * Deletes an orphan row with no reference check: a node or App resolves names only from stores on
 * its own graph or space, so none resolves a row whose store is on no graph, and an agent's
 * `remote_*` call that reaches it by name leaves no stored reference to check.
 */
async function secretsStoreDeleteOrphan(storeId: string, id: string): Promise<void> {
  const [rows, stores] = await Promise.all([secrets.listAllKeys(), graph.listNodesByType('core-secrets-store')])
  const refusal = refuseOrphanDelete(storeId, id, rows, stores)
  if (refusal) {
    throw new Error(refusal)
  }
  await secrets.deleteById(id)
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
  const result = await terminal.execResult(ctx, command, opts)
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
  const out = await ssh.exec(config, script)
  const lines: Record<string, string> = {}
  for (const line of out.trim().split('\n')) {
    const [key, ...rest] = line.split('=')
    lines[key] = rest.join('=')
  }
  return {
    os: lines.OS || 'unknown',
    cpu: lines.CPU || 'unknown',
    memory: lines.MEMORY || 'unknown',
    storage: lines.STORAGE || 'unknown',
  }
}

// ═══════════════════════════════════════════════════════════════════
// Action registry
// ═══════════════════════════════════════════════════════════════════

// A route's target as the router's inspector adds it: refused when it is a
// router's route (the inspector then adds nothing), else its context. A target
// that does not resolve throws, and the inspector adds the route unresolved.
// "node-id/handle-id", split at the first slash like every other target consumer.
async function resolveRouteTarget(target: string): Promise<TerminalRouteResolution> {
  const nodeId = targetNodeId(target)
  if (!nodeId) {
    throw new Error(`Not a terminal target: "${target}" (expected "node-id/handle-id")`)
  }
  const node = await graph.getNode(nodeId)
  if (node?.type === storedType(extensionId, TERMINAL_ROUTER_TYPE)) {
    const reaches = routeTarget(target.slice(nodeId.length + 1), node.data as TerminalRouterData)
    return { refused: routeToRouteText(target, nodeId, reaches) }
  }
  return { context: await terminal.getContext(nodeId, target.slice(nodeId.length + 1)) }
}

export const actions = {
  'localhost.getStats': () => getLocalhostStats(),
  'wsl.getStats': (distro: string) => getWslStats(distro),
  'keyStore.listKeys': (storeId: string) => keyStoreShowKeys(storeId),
  'keyStore.createKey': (storeId: string, name: string, keyType: string) => keyStoreCreateKey(storeId, name, keyType),
  'keyStore.importKey': (storeId: string, name: string, content: string) => keyStoreImportKey(storeId, name, content),
  'keyStore.references': (storeId: string, name: string) => keyStoreReferences(storeId, name),
  // `shown`: the ids of the nodes the inspector's confirm listed, the only ones it deletes past.
  'keyStore.deleteKey': (storeId: string, name: string, shown?: unknown) =>
    keyStoreDeleteKey(storeId, name, shownOverride(shown)),
  'keyStore.readPublicKey': (storeId: string, name: string) => keyStoreReadPublicKey(storeId, name),
  'keyStore.hasWsl': () => keyStoreHasWsl(),
  'keyStore.copyKeyToWsl': (storeId: string, name: string) => keyStoreCopyKeyToWsl(storeId, name),
  'keyStore.removeKeyFromWsl': (name: string) => keyStoreRemoveKeyFromWsl(name),
  'secretsStore.getSecrets': (storeId: string) => secretsStoreGetSecrets(storeId),
  'secretsStore.setSecret': (storeId: string, key: string, value: string) =>
    secretsStoreSet(String(storeId ?? ''), key, value),
  // A login that is not a non-empty string without ":", or an empty password, is refused.
  'secretsStore.setPassword': (storeId: string, key: string, login: unknown, password: unknown, basic: unknown) =>
    secretsStoreSetPassword(String(storeId ?? ''), key, login, password, basic === true),
  // `shown`: as for `keyStore.deleteKey`.
  'secretsStore.deleteSecret': (storeId: string, key: string, shown?: unknown) =>
    secretsStoreDelete(String(storeId ?? ''), String(key ?? ''), shownOverride(shown)),
  // `shown`: as for `keyStore.deleteKey`; it overrides the same in-use check.
  'secretsStore.renameSecret': (storeId: string, from: string, to: string, shown?: unknown) =>
    secretsStoreRename(String(storeId ?? ''), String(from ?? ''), String(to ?? ''), shownOverride(shown)),
  // `options`: as for `secretsStore.generate`; left out, the stored recipe decides.
  'secretsStore.rotateSecret': (storeId: string, key: string, options?: GenerateSecretOptions) =>
    secretsStoreRotate(String(storeId ?? ''), String(key ?? ''), options ?? undefined),
  'secretsStore.references': (storeId: string, key: string) =>
    secretsStoreReferences(String(storeId ?? ''), String(key ?? '')),
  'secretsStore.generate': (
    storeId: string,
    name: string,
    options?: GenerateSecretOptions,
  ): Promise<GenerateSecretResult> => secretsStoreGenerate(storeId, name, options),
  'secretsStore.listOrphans': (storeId: string) => secretsStoreListOrphans(String(storeId ?? '')),
  'secretsStore.deleteOrphan': (storeId: string, id: string) =>
    secretsStoreDeleteOrphan(String(storeId ?? ''), String(id ?? '')),
  'server.getStats': (config: ServerConfig) => serverGetStats(config),
  'server.hostKeyStatus': (address: string, port: number) => hostKeyStatus(address, port),
  'server.acceptHostKey': (address: string, port: number) => acceptHostKey(address, port),
  'server.installKey': async (config: ServerConfig, keyRef: string) =>
    installPublicKey(config, await resolvePublicKey(keyRef)),
  'terminal.run': (ctx: TerminalContext, args: string[]) => terminal.run(ctx, args),
  // A Terminal Router route's context at the moment it is added (see the node's inspector).
  'terminalRouter.resolve': (target: string) => resolveRouteTarget(String(target ?? '')),
  'terminal.exec': (ctx: TerminalContext, command: string, opts?: ExecOptions) =>
    terminalExecWithOpts(ctx, command, opts),
  'terminal.execDetailed': (ctx: TerminalContext, command: string, opts?: ExecOptions) =>
    terminalExecDetailed(ctx, command, opts),
  'script.run': (params: ScriptRunParams) => runScript(params),
  'handler.run': (params: HandlerRunParams) => runHandler(params),
  'agent.listAgentCatalog': () => listAgentCatalog(),
  'agent.checkTerminal': (params: Parameters<typeof checkAgentTerminal>[0]) => checkAgentTerminal(params ?? {}),
  // Each takes the agent node, from whose graph its secrets resolve.
  'agent.listModels': (params: Parameters<typeof listModels>[0]) => listModels(params),
  // Computed per-model on demand (not baked into listAgentCatalog) so it also
  // covers models discovered from an OpenAI-compatible endpoint or typed in by
  // hand, not just the static AGENT_PROVIDERS catalog.
  'agent.reasoningEfforts': (model: string) => reasoningEfforts(String(model ?? '')),
  // Each takes the agent node, whose own harness home the login lives in.
  'agent.oauthStatus': async (adapterId: string, nodeId: string) =>
    oauthLoginStatus(String(adapterId ?? ''), await agentOauthPlacement(nodeId)),
  'agent.oauthStart': async (adapterId: string, nodeId: string) =>
    startOauthLogin(String(adapterId ?? ''), await agentOauthPlacement(nodeId)),
  'agent.oauthSubmitCode': (params: { loginId?: string; code?: string }) =>
    submitOauthCode(String(params?.loginId ?? ''), String(params?.code ?? '')),
  'agent.oauthAwait': (loginId: string) => awaitOauthLogin(String(loginId ?? '')),
  'agent.oauthDisconnect': async (adapterId: string, nodeId: string) =>
    disconnectOauth(String(adapterId ?? ''), await agentOauthPlacement(nodeId)),
  // The agent's credentials for the MCP endpoint (the node's Tokens tab). The
  // plaintext comes back from create only; list never carries it. `input` is
  // passed through as sent: an absent expiry must be refused by the host's
  // validation, not defaulted here to "never".
  'agent.listMcpTokens': (nodeId: string) => mcpTokens.list(String(nodeId ?? '')),
  'agent.createMcpToken': (nodeId: string, input: { name: string; expiresAt: string | null }) =>
    mcpTokens.create(String(nodeId ?? ''), input),
  'agent.deleteMcpToken': (nodeId: string, id: string) => mcpTokens.delete(String(nodeId ?? ''), String(id ?? '')),
  // The node's Instructions tab: which files its harness reads, and the shared
  // text of its place. The agent's own text and the system prompt are node
  // data, written as any other field; the shared text is written here, only
  // to the place and at the version the tab read.
  'agent.readInstructions': (nodeId: string) => agentInstructions.read(String(nodeId ?? '')),
  'agent.writeSharedInstructions': (nodeId: string, text: string, expected: { place: string; version: number }) =>
    agentInstructions.write(String(nodeId ?? ''), 'shared', String(text ?? ''), {
      expected: { place: String(expected?.place ?? ''), version: Number(expected?.version ?? 0) },
    }),
  'tts.capabilities': (params: { nodeId?: string; baseUrl?: string; apiKey?: string; headers?: HeaderPair[] }) =>
    ttsCapabilities(params),
  // A Call Action's pickers: what it may target, and the actions a target offers it.
  'callAction.targets': (nodeId: string) => execContext.callTargets(String(nodeId ?? '')),
  'callAction.actions': (nodeId: string, target: GraphCallTarget) =>
    execContext.callableActions(String(nodeId ?? ''), target),
}

// ═══════════════════════════════════════════════════════════════════
// exposeOutput
// ═══════════════════════════════════════════════════════════════════

export const exposeOutput = (
  handleId: string,
  nodeData: Record<string, unknown>,
  type: string,
  nodeId: string,
  run?: unknown,
  enumCasesOf: EnumCasesOf = NO_ENUMS,
): unknown => {
  if (type === TERMINAL_ROUTER_TYPE) {
    return routeOutput(handleId, nodeData as TerminalRouterData)
  }

  // What an API Route, an Event or an Agent Tool was given, while its run dispatches.
  if (Object.hasOwn(RUN_OUTPUTS, type)) {
    return runOutputValue(type, handleId, run)
  }

  // A Call Action's outcome, while its Done or Failed dispatches.
  if (type === CALL_ACTION) {
    return callActionOutputValue(handleId, run)
  }

  const valueNode = bareValueNodeType(type)
  if (valueNode) {
    return valueNodeExposed(valueNode, handleId, nodeData, enumCasesOf)
  }

  // An input port's typed value, to the nodes it feeds inside while nothing outside feeds it.
  if (type === 'subgraph') {
    return portValueOf(nodeData, handleId)
  }

  if (type === 'localhost') {
    if (handleId === 'terminal') {
      return { type: 'local' }
    }
    return undefined
  }

  if (type === 'wsl') {
    const distro = nodeData.distro as string | undefined
    if (!distro) {
      return undefined
    }
    if (handleId === 'terminal') {
      return { type: 'wsl', distro }
    }
    return undefined
  }

  if (type === 'server') {
    const address = nodeData.address as string | undefined
    if (!address) {
      return undefined
    }
    if (handleId === 'terminal') {
      return {
        type: 'ssh',
        host: address,
        port: (nodeData.port as number) || 22,
        username: (nodeData.username as string) || 'root',
        password: nodeData.password as string | undefined,
        // A `secret:NAME` password resolves from the Secrets Stores on this node's graph, and a
        // `<storeId>:<name>` key only from a Key Store there.
        credentialsScope: nodeId,
        keyPath: nodeData.keyPath as string | undefined,
      }
    }
    return undefined
  }

  return undefined
}
