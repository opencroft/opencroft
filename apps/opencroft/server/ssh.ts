import { promises as fs } from 'node:fs'

import { cacheDir } from '@/server/cache'

export interface ServerConfig {
  address: string
  port: number
  username: string
  keyPath?: string
  password?: string
}

function parseKeyRef(keyPath?: string): { storeId: string; name: string } | null {
  if (!keyPath || keyPath.includes('/') || /^[A-Z]:\\/i.test(keyPath)) {
    return null
  }
  const colon = keyPath.indexOf(':')
  if (colon < 0) {
    return null
  }
  return { storeId: keyPath.slice(0, colon), name: keyPath.slice(colon + 1) }
}

/**
 * Resolve an SSH private key. A `storeId:name` reference reads from the
 * Key Store node's cache (a `builtin/core` node); anything else is a path.
 */
export async function resolveKeyContent(keyPath?: string): Promise<string | undefined> {
  if (!keyPath) {
    return undefined
  }
  const parsed = parseKeyRef(keyPath)
  if (parsed) {
    const file = cacheDir('extensions', 'builtin/core', 'key-store', parsed.storeId, parsed.name)
    return fs.readFile(file, 'utf-8')
  }
  return fs.readFile(keyPath, 'utf-8')
}

export async function sshExec(config: ServerConfig, command: string): Promise<string> {
  const { Client } = await import('ssh2')
  const privateKey = await resolveKeyContent(config.keyPath)
  return new Promise<string>((resolve, reject) => {
    const client = new Client()
    let stdout = ''
    let stderr = ''
    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          client.end()
          reject(err)
          return
        }
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        stream.on('close', () => {
          client.end()
          if (stderr && !stdout) {
            reject(new Error(stderr))
            return
          }
          resolve(stdout)
        })
      })
    })
    client.on('error', reject)
    const connectOptions: Record<string, unknown> = {
      host: config.address,
      port: config.port || 22,
      username: config.username || 'root',
      readyTimeout: 10000,
    }
    if (config.password) {
      connectOptions.password = config.password
    }
    if (privateKey) {
      connectOptions.privateKey = privateKey
    }
    client.connect(connectOptions)
  })
}
