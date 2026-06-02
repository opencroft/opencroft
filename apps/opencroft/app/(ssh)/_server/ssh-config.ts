import { promises as fs } from 'fs'
import os from 'os'
import pathLib from 'path'

import { sshKeys } from '@/app/(server)/_server/ssh-key'
import { setPermissions } from '@/app/(server)/_server/ssh-utils'
import { getSshFeature, type Server, slug } from '@/app/(server)/_server/types'
import { exec } from '@/server/shell'

export interface SshConfigEntry {
  host: string
  properties: Record<string, string>
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

// --- Local config (native filesystem) ---

const localConfigPath = pathLib.join(os.homedir(), '.ssh', 'config')

export const local = {
  async load(): Promise<SshConfigEntry[]> {
    try {
      return parse(await fs.readFile(localConfigPath, 'utf-8'))
    } catch {
      return []
    }
  },

  async save(entries: SshConfigEntry[]): Promise<void> {
    await fs.mkdir(pathLib.join(os.homedir(), '.ssh'), { recursive: true })
    await fs.writeFile(localConfigPath, serialize(entries))
    await setPermissions(localConfigPath)
  },

  async set(entry: SshConfigEntry): Promise<void> {
    const entries = await local.load()
    const idx = entries.findIndex((e) => e.host === entry.host)
    if (idx >= 0) {
      entries[idx] = entry
    } else {
      entries.push(entry)
    }
    await local.save(entries)
  },

  async remove(host: string): Promise<void> {
    const entries = await local.load()
    await local.save(entries.filter((e) => e.host !== host))
  },
}

// --- WSL config (via shell exec) ---

export const wsl = {
  async load(): Promise<SshConfigEntry[]> {
    try {
      return parse(await exec('cat ~/.ssh/config 2>/dev/null || true'))
    } catch {
      return []
    }
  },

  async save(entries: SshConfigEntry[]): Promise<void> {
    const content = serialize(entries)
    await exec(`mkdir -p ~/.ssh && cat > ~/.ssh/config << 'SSHCONFIGEOF'\n${content}SSHCONFIGEOF`)
    await exec('chmod 600 ~/.ssh/config')
  },

  async set(entry: SshConfigEntry): Promise<void> {
    const entries = await wsl.load()
    const idx = entries.findIndex((e) => e.host === entry.host)
    if (idx >= 0) {
      entries[idx] = entry
    } else {
      entries.push(entry)
    }
    await wsl.save(entries)
  },

  async remove(host: string): Promise<void> {
    const entries = await wsl.load()
    await wsl.save(entries.filter((e) => e.host !== host))
  },
}

// --- Convenience: set/remove on both ---

export async function set(entry: SshConfigEntry): Promise<void> {
  await local.set(entry)
  if (os.platform() === 'win32') {
    await wsl.set(entry)
  }
}

export async function remove(host: string): Promise<void> {
  await local.remove(host)
  if (os.platform() === 'win32') {
    await wsl.remove(host)
  }
}

// --- Server helpers ---

function serverEntry(server: Server): SshConfigEntry | null {
  const ssh = getSshFeature(server)
  if (!ssh?.keyPath) {
    return null
  }
  return {
    host: slug(server.name),
    properties: {
      HostName: server.address,
      User: ssh.username || 'root',
      Port: String(ssh.port || 22),
      IdentityFile: ssh.keyPath,
      StrictHostKeyChecking: 'no',
    },
  }
}

export async function setServer(server: Server): Promise<void> {
  const entry = serverEntry(server)
  if (!entry) {
    return
  }

  // Local config uses the key path as-is
  await local.set(entry)

  // WSL config: copy key and use WSL-relative path
  if (os.platform() === 'win32') {
    const ssh = getSshFeature(server)!
    const name = sshKeys.name(ssh.keyPath!)
    await sshKeys.copyToWsl(ssh.keyPath!, name)
    await wsl.set({
      ...entry,
      properties: { ...entry.properties, IdentityFile: `~/.ssh/keys/${name}` },
    })
  }
}

export async function removeServer(alias: string): Promise<void> {
  await remove(alias)
}
