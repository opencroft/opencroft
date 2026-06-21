import host from '@ext/host'
import type { ServerConfig, TerminalContext } from '@opencroft/server'
import { AGENT_PROVIDERS } from 'agent-client/agent-providers'
import { HARNESS_ADAPTERS } from 'agent-client/harness-adapters'
import { reasoningEfforts } from 'agent-client/reasoning'

import { nodeActions } from './node-actions'
import { type OpenAIChatParams, openaiChat } from './openai'
import { type HandlerRunParams, runHandler, runScript, type ScriptRunParams } from './script'

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
    headers['Authorization'] = `Bearer ${key}`
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
// Helpers
// ═══════════════════════════════════════════════════════════════════

async function setKeyPermissions(filePath: string): Promise<void> {
  if (!isWindows) {
    await host.fs.chmod(filePath, 0o600)
    return
  }
  await host.execFile('icacls', [filePath, '/inheritance:r', '/grant:r', `${host.os.userInfo().username}:F`])
}

async function isPrivateKey(filePath: string): Promise<boolean> {
  try {
    const content = await host.fs.readFile(filePath, 'utf-8')
    return content.includes('PRIVATE KEY') || content.includes('-----BEGIN')
  } catch {
    return false
  }
}

async function isKeyInWsl(name: string): Promise<boolean> {
  try {
    await host.exec(`test -f ~/.ssh/keys/${name}`)
    return true
  } catch {
    return false
  }
}

function keyStoreDir(nodeId: string): string {
  return host.cacheDir('key-store', nodeId)
}

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
      const free = parseInt(parts[1] || '0')
      const total = parseInt(parts[2] || '0')
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
// Key Store
// ═══════════════════════════════════════════════════════════════════

interface KeyEntry {
  name: string
  type: string
  fingerprint: string
  hasPublicKey: boolean
  inWsl: boolean
}

async function keyStoreListKeys(storeId: string): Promise<KeyEntry[]> {
  const dir = keyStoreDir(storeId)
  let entries: string[]
  try {
    entries = await host.fs.readdir(dir)
  } catch {
    return []
  }
  const keys: KeyEntry[] = []
  for (const name of entries) {
    if (name.endsWith('.pub')) {
      continue
    }
    const filePath = host.path.join(dir, name)
    const stat = await host.fs.stat(filePath)
    if (!stat.isFile() || !(await isPrivateKey(filePath))) {
      continue
    }
    let type = 'unknown'
    let fingerprint = ''
    try {
      const info = await host.execFile('ssh-keygen', ['-l', '-f', filePath])
      const match = info.match(/^\d+\s+(\S+)\s+.*\((\w+)\)/)
      if (match) {
        fingerprint = match[1]
        type = match[2]
      }
    } catch {
      /* best effort */
    }
    let hasPublicKey = false
    try {
      await host.fs.access(`${filePath}.pub`)
      hasPublicKey = true
    } catch {
      /* no pub */
    }
    const inWsl = isWindows ? await isKeyInWsl(name) : false
    keys.push({ name, type, fingerprint, hasPublicKey, inWsl })
  }
  return keys
}

async function keyStoreCreateKey(storeId: string, name: string, keyType: string): Promise<void> {
  const dir = keyStoreDir(storeId)
  await host.fs.mkdir(dir, { recursive: true })
  await host.execFile('ssh-keygen', ['-t', keyType, '-f', host.path.join(dir, name), '-N', '', '-q'])
}

async function keyStoreImportKey(storeId: string, name: string, content: string): Promise<void> {
  const dir = keyStoreDir(storeId)
  await host.fs.mkdir(dir, { recursive: true })
  const keyPath = host.path.join(dir, name)
  await host.fs.writeFile(keyPath, content)
  await setKeyPermissions(keyPath)
}

async function keyStoreDeleteKey(storeId: string, name: string): Promise<void> {
  const dir = keyStoreDir(storeId)
  const keyPath = host.path.join(dir, name)
  await host.fs.unlink(keyPath).catch(() => null)
  await host.fs.unlink(`${keyPath}.pub`).catch(() => null)
}

async function keyStoreReadPublicKey(storeId: string, name: string): Promise<string> {
  const keyPath = host.path.join(keyStoreDir(storeId), name)
  try {
    return await host.fs.readFile(`${keyPath}.pub`, 'utf-8')
  } catch {
    return host.execFile('ssh-keygen', ['-y', '-f', keyPath])
  }
}

async function keyStoreCopyKeyToWsl(storeId: string, name: string): Promise<void> {
  const keyPath = host.path.join(keyStoreDir(storeId), name)
  const content = await host.fs.readFile(keyPath, 'utf-8')
  await host.exec('mkdir -p ~/.ssh/keys')
  await host.exec(`cat > ~/.ssh/keys/${name} << 'KEYEOF'\n${content}\nKEYEOF`)
  await host.exec(`chmod 600 ~/.ssh/keys/${name}`)
  try {
    const pub = await host.fs.readFile(`${keyPath}.pub`, 'utf-8')
    await host.exec(`cat > ~/.ssh/keys/${name}.pub << 'KEYEOF'\n${pub}\nKEYEOF`)
  } catch {
    /* no pub */
  }
}

async function keyStoreRemoveKeyFromWsl(name: string): Promise<void> {
  await host.exec(`rm -f ~/.ssh/keys/${name} ~/.ssh/keys/${name}.pub`)
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
