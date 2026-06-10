import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { exec } from './shell'

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

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolve(stdout)
    })
  })
}

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
      return await run('ssh-keygen', ['-y', '-f', keyPath])
    }
  },

  async create(name: string, keyType: string): Promise<void> {
    await fs.mkdir(keysDir, { recursive: true })
    const keyPath = path.join(keysDir, name)
    await run('ssh-keygen', ['-t', keyType, '-f', keyPath, '-N', '', '-q'])
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
        if (name.endsWith('.pub') || name === 'known_hosts' || name === 'known_hosts.old' || name === 'config' || name === 'authorized_keys' || name.endsWith('.Identifier')) {
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
        try {
          const info = await run('ssh-keygen', ['-l', '-f', filePath])
          const match = info.match(/^\d+\s+(\S+)\s+.*\((\w+)\)/)
          if (match) {
            fingerprint = match[1]
            type = match[2]
          }
        } catch {
          // key may not be parseable
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
