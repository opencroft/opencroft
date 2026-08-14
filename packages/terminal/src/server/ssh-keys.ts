import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { exec } from './shell'
import { derivePublicKey, generateSshKey, inspectSshKey, type SshKeyType } from './ssh-key-format'

export interface SshKey {
  name: string
  path: string
  type: string
  fingerprint: string
  hasPublicKey: boolean
  inWsl: boolean
}

const isWindows = os.platform() === 'win32'
const sshDir = path.join(os.homedir(), '.ssh')
const keysDir = path.join(sshDir, 'keys')

export function setPermissions(filePath: string): Promise<void> {
  if (!isWindows) {
    return fs.chmod(filePath, 0o600)
  }
  return new Promise((resolve, reject) => {
    execFile('icacls', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

// --- Helpers ---

async function isPrivateKey(filePath: string): Promise<boolean> {
  const content = await fs.readFile(filePath, 'utf-8')
  return content.includes('PRIVATE KEY') || content.includes('-----BEGIN')
}

// --- WSL helpers ---

async function isKeyInWsl(name: string): Promise<boolean> {
  try {
    await exec('test -f ~/.ssh/keys/' + name)
    return true
  } catch {
    return false
  }
}

// --- Public API ---

export const sshKeys = {
  name(keyPath: string): string {
    return keyPath.split(/[/\\]/).pop()!
  },

  read(keyPath: string): Promise<string> {
    return fs.readFile(keyPath, 'utf-8')
  },

  async readPublicKey(keyPath: string): Promise<string> {
    try {
      return await fs.readFile(`${keyPath}.pub`, 'utf-8')
    } catch {
      // Derived from the private key rather than shelled out to
      // `ssh-keygen -y`, so a host without openssh-client can still answer.
      return derivePublicKey(await fs.readFile(keyPath, 'utf-8'))
    }
  },

  async create(name: string, keyType: string): Promise<void> {
    await fs.mkdir(keysDir, { recursive: true })
    const keyPath = path.join(keysDir, name)
    const key = generateSshKey(keyType as SshKeyType, name)
    await fs.writeFile(keyPath, key.privateKey, { mode: 0o600 })
    await fs.writeFile(`${keyPath}.pub`, key.publicKey)
    // Explicit, because writeFile's mode is only applied when it creates the
    // file -- overwriting an existing key would keep the old permissions.
    await setPermissions(keyPath)
  },

  async import(name: string, content: string): Promise<void> {
    await fs.mkdir(keysDir, { recursive: true })
    const keyPath = path.join(keysDir, name)
    await fs.writeFile(keyPath, content)
    await setPermissions(keyPath)
  },

  async delete(keyPath: string): Promise<void> {
    await fs.unlink(keyPath).catch(() => {})
    await fs.unlink(`${keyPath}.pub`).catch(() => {})
  },

  async list(): Promise<SshKey[]> {
    const dirs = [sshDir, keysDir]
    const keys: SshKey[] = []

    for (const dir of dirs) {
      let entries: string[]
      try {
        entries = await fs.readdir(dir)
      } catch {
        continue
      }

      for (const name of entries) {
        if (
          name.endsWith('.pub') ||
          name === 'known_hosts' ||
          name === 'known_hosts.old' ||
          name === 'config' ||
          name === 'authorized_keys' ||
          name.endsWith('.Identifier')
        ) {
          continue
        }

        const filePath = path.join(dir, name)
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) {
          continue
        }

        try {
          if (!(await isPrivateKey(filePath))) {
            continue
          }
        } catch {
          continue
        }

        let type = 'unknown'
        let fingerprint = ''
        // Best effort by design: one unreadable key costs its own metadata,
        // not the listing.
        const info = inspectSshKey(await fs.readFile(filePath, 'utf-8').catch(() => ''))
        if (info) {
          fingerprint = info.fingerprint
          type = info.type
        }

        let hasPublicKey = false
        try {
          await fs.access(`${filePath}.pub`)
          hasPublicKey = true
        } catch {
          // no public key file
        }

        const inWsl = isWindows ? await isKeyInWsl(name) : false
        keys.push({ name, path: filePath, type, fingerprint, hasPublicKey, inWsl })
      }
    }

    return keys
  },

  async copyToWsl(keyPath: string, name: string): Promise<void> {
    const content = await fs.readFile(keyPath, 'utf-8')
    await exec('mkdir -p ~/.ssh/keys')
    await exec(`cat > ~/.ssh/keys/${name} << 'KEYEOF'\n${content}\nKEYEOF`)
    await exec(`chmod 600 ~/.ssh/keys/${name}`)
    try {
      const pub = await fs.readFile(`${keyPath}.pub`, 'utf-8')
      await exec(`cat > ~/.ssh/keys/${name}.pub << 'KEYEOF'\n${pub}\nKEYEOF`)
    } catch {
      // no public key
    }
  },

  async removeFromWsl(name: string): Promise<void> {
    await exec(`rm -f ~/.ssh/keys/${name} ~/.ssh/keys/${name}.pub`)
  },
}
