import { promises as fs } from 'node:fs'
import os from 'node:os'
import pathLib from 'node:path'

import { exec } from './shell'
import { setPermissions } from './ssh-keys'

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
