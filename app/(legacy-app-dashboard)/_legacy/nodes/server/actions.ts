import { promises as fs } from 'node:fs'
import os from 'node:os'
import pathLib from 'node:path'

import { createServerFn } from '@tanstack/react-start'

import { setPermissions } from '@/app/(server)/_server/ssh-utils'
import { getSshFeature, type Server, slug } from '@/app/(server)/_server/types'
import { cacheDir } from '@/server/cache'
import { exec } from '@/server/shell'

interface SshConfigEntry {
  host: string
  properties: Record<string, string>
}

function serialize(entries: SshConfigEntry[]): string {
  return (
    entries
      .map((e) => {
        const props = Object.entries(e.properties)
          .map(([k, v]) => `    ${k} ${v}`)
          .join('\n')
        return `Host ${e.host}\n${props}`
      })
      .join('\n\n') + '\n'
  )
}

function parse(raw: string): SshConfigEntry[] {
  const lines = raw.replace(/\r/g, '').split('\n')
  const entries: SshConfigEntry[] = []
  let current: SshConfigEntry | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const hostMatch = trimmed.match(/^Host\s+(.+)$/)
    if (hostMatch) {
      current = { host: hostMatch[1].trim(), properties: {} }
      entries.push(current)
      continue
    }
    if (current) {
      const propMatch = trimmed.match(/^(\S+)\s+(.+)$/)
      if (propMatch) {
        current.properties[propMatch[1]] = propMatch[2]
      }
    }
  }
  return entries
}

function sshConfigPath(): string {
  return cacheDir('ssh-config')
}

async function loadConfig(): Promise<SshConfigEntry[]> {
  try {
    return parse(await fs.readFile(sshConfigPath(), 'utf-8'))
  } catch {
    return []
  }
}

async function saveConfig(entries: SshConfigEntry[]): Promise<void> {
  const p = sshConfigPath()
  await fs.mkdir(pathLib.dirname(p), { recursive: true })
  await fs.writeFile(p, serialize(entries))
  await setPermissions(p)
}

function resolveKeyPath(keyRef: string): string {
  const [storeId, keyName] = keyRef.split(':')
  return cacheDir('ssh-keys', storeId, keyName)
}

export const resolveServer = createServerFn({ method: 'POST' })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }): Promise<Server> => {
    const ssh = getSshFeature(server)
    if (!ssh?.keyPath || !ssh.keyPath.includes(':')) {
      return server
    }
    const resolved = resolveKeyPath(ssh.keyPath)
    return {
      ...server,
      features: server.features.map((f) => (f.type === 'ssh' ? { ...f, keyPath: resolved } : f)),
    }
  })

export const applyServerConfig = createServerFn({ method: 'POST' })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }): Promise<void> => {
    const ssh = getSshFeature(server)
    if (!ssh?.keyPath) {
      return
    }

    const keyPath = resolveKeyPath(ssh.keyPath)
    const alias = slug(server.name)

    const entry: SshConfigEntry = {
      host: alias,
      properties: {
        HostName: server.address,
        User: ssh.username || 'root',
        Port: String(ssh.port || 22),
        IdentityFile: keyPath,
        StrictHostKeyChecking: 'no',
      },
    }

    const entries = await loadConfig()
    const idx = entries.findIndex((e) => e.host === alias)
    if (idx >= 0) {
      entries[idx] = entry
    } else {
      entries.push(entry)
    }
    await saveConfig(entries)

    if (os.platform() === 'win32') {
      const wslKeyPath = `~/.ssh/keys/${pathLib.basename(keyPath)}`
      const content = await fs.readFile(keyPath, 'utf-8')
      await exec('mkdir -p ~/.ssh/keys')
      await exec(`cat > ${wslKeyPath} << 'KEYEOF'\n${content}\nKEYEOF`)
      await exec(`chmod 600 ${wslKeyPath}`)

      const wslEntry = { ...entry, properties: { ...entry.properties, IdentityFile: wslKeyPath } }
      const wslEntries = await loadWslConfig()
      const wslIdx = wslEntries.findIndex((e) => e.host === alias)
      if (wslIdx >= 0) {
        wslEntries[wslIdx] = wslEntry
      } else {
        wslEntries.push(wslEntry)
      }
      await saveWslConfig(wslEntries)
    }
  })

export const removeServerConfig = createServerFn({ method: 'POST' })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }): Promise<void> => {
    const alias = slug(name)
    const entries = await loadConfig()
    await saveConfig(entries.filter((e) => e.host !== alias))

    if (os.platform() === 'win32') {
      const wslEntries = await loadWslConfig()
      await saveWslConfig(wslEntries.filter((e) => e.host !== alias))
    }
  })

async function loadWslConfig(): Promise<SshConfigEntry[]> {
  try {
    return parse(await exec('cat ~/.ssh/config 2>/dev/null || true'))
  } catch {
    return []
  }
}

async function saveWslConfig(entries: SshConfigEntry[]): Promise<void> {
  const content = serialize(entries)
  await exec(`mkdir -p ~/.ssh && cat > ~/.ssh/config << 'SSHCONFIGEOF'\n${content}SSHCONFIGEOF`)
  await exec('chmod 600 ~/.ssh/config')
}
