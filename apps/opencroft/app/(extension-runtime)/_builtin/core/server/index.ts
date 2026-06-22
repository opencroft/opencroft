import host from '@ext/host'
import type { ServerConfig, TerminalContext } from '@opencroft/server'
import { AGENT_PROVIDERS } from 'agent-client/agent-providers'
import { HARNESS_ADAPTERS } from 'agent-client/harness-adapters'
import { reasoningEfforts } from 'agent-client/reasoning'

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
import { acceptHostKey, hostKeyStatus, installPublicKey, resolvePublicKey } from './ssh-setup'

export { nodeActions }

// ═══════════════════════════════════════════════════════════════════
// Agent profile catalog (agent-client harnesses + providers)
// ═══════════════════════════════════════════════════════════════════

interface AgentCatalog {
  adapters: { id: string; label: string; protocol: string; kind: 'acp' | 'native' }[]
  providers: { id: string; label: string; models: string[]; protocols: string[] }[]
  // model id -> supported reasoning-effort levels ([] when the model has none).
  reasoning: Record<string, string[]>
}

function listAgentCatalog(): AgentCatalog {
  const reasoning: Record<string, string[]> = {}
  for (const provider of AGENT_PROVIDERS) {
    for (const model of provider.models) {
      reasoning[model] = reasoningEfforts(model)
    }
  }
  return {
    adapters: HARNESS_ADAPTERS.map((a) => ({
      id: a.id,
      label: a.label,
      protocol: a.protocol,
      kind: a.kind ?? 'acp',
    })),
    providers: AGENT_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      protocols: Object.keys(p.endpoints),
    })),
    reasoning,
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
  'secretsStore.listOrphans': (storeId: string) => secretsStoreListOrphans(storeId),
  'secretsStore.deleteOrphan': (id: string) => secretsStoreDeleteOrphan(id),
  'server.getStats': (config: ServerConfig) => serverGetStats(config),
  'server.resolveKey': (keyPath: string) => host.ssh.resolveKey(keyPath),
  'server.hostKeyStatus': (address: string, port: number) => hostKeyStatus(address, port),
  'server.acceptHostKey': (address: string, port: number) => acceptHostKey(address, port),
  'server.installKey': async (config: ServerConfig, keyRef: string) =>
    installPublicKey(config, await resolvePublicKey(keyRef)),
  'terminal.run': (ctx: TerminalContext, args: string[]) => host.terminal.run(ctx, args),
  'terminal.exec': (ctx: TerminalContext, command: string) => host.terminal.exec(ctx, command),
  'script.run': (params: ScriptRunParams) => runScript(params),
  'handler.run': (params: HandlerRunParams) => runHandler(params),
  'openai.chat': (params: OpenAIChatParams) => openaiChat(params),
  'agent.listAgentCatalog': () => listAgentCatalog(),
  'agent.listModels': (params: { baseUrl?: string; apiKeySecret?: string }) => listModels(params),
}

// ═══════════════════════════════════════════════════════════════════
// exposeOutput
// ═══════════════════════════════════════════════════════════════════

export const exposeOutput = (handleId: string, nodeData: Record<string, unknown>, typeId: string): unknown => {
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
