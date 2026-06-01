import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { Client, type SFTPWrapper } from 'ssh2'
import type { Readable } from 'stream'

import { cacheDir } from '@/server/cache'

// --- Types ---

export interface SshCredentials {
  host: string
  port?: number
  username: string
  password?: string
  keyPath?: string
}

export interface SftpEntry {
  name: string
  isDirectory: boolean
  size: number
  mtime: number
}

type SshTarget = string | SshCredentials

// --- Key ref resolver ---

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

async function resolveKeyContent(keyPath?: string): Promise<string | undefined> {
  if (!keyPath) {
    return undefined
  }
  const parsed = parseKeyRef(keyPath)
  if (parsed) {
    // Search all extension cache dirs for the key
    const baseCache = cacheDir('extensions')
    const candidates = [path.join(baseCache, 'local', 'core', 'key-store', parsed.storeId, parsed.name), path.join(baseCache, 'builtin', 'core', 'key-store', parsed.storeId, parsed.name)]
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate, 'utf-8')
      } catch {
        /* try next */
      }
    }
    // Brute-force scan
    try {
      const scopes = await fs.readdir(baseCache)
      for (const scope of scopes) {
        const scopeDir = path.join(baseCache, scope)
        const stat = await fs.stat(scopeDir).catch(() => null)
        if (!stat?.isDirectory()) {
          continue
        }
        const exts = await fs.readdir(scopeDir).catch(() => [])
        for (const ext of exts) {
          const candidate = path.join(scopeDir, ext, 'key-store', parsed.storeId, parsed.name)
          try {
            return await fs.readFile(candidate, 'utf-8')
          } catch {
            /* try next */
          }
        }
      }
    } catch {
      /* ignore */
    }
    throw new Error(`SSH key not found: ${parsed.name} (store: ${parsed.storeId})`)
  }
  return fs.readFile(keyPath, 'utf-8')
}

// --- ssh2 connection ---

async function connectSsh2(creds: SshCredentials): Promise<Client> {
  const keyContent = creds.keyPath ? await resolveKeyContent(creds.keyPath) : undefined

  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    client.connect({
      host: creds.host,
      port: creds.port || 22,
      username: creds.username,
      password: creds.password || undefined,
      privateKey: keyContent,
      readyTimeout: 5000,
    })
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        client.end()
        reject(err)
        return
      }
      resolve(sftp)
    })
  })
}

// --- Native ssh helpers ---

function sshSpawn(alias: string, command: string, stdio: 'pipe-all' | 'pipe-stdin'): ReturnType<typeof spawn> {
  const args = ['-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', alias, command]
  return spawn('ssh', args, {
    stdio: stdio === 'pipe-all' ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  })
}

function nativeExec(alias: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = sshSpawn(alias, command, 'pipe-all')

    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ssh exited with code ${code}`))
        return
      }
      resolve(stdout)
    })
    proc.on('error', reject)
  })
}

function ssh2Exec(creds: SshCredentials, command: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const client = await connectSsh2(creds).catch(reject)
    if (!client) {
      return
    }

    client.exec(command, (err, channel) => {
      if (err) {
        client.end()
        reject(err)
        return
      }

      let stdout = ''
      let stderr = ''
      channel.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      channel.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      channel.on('close', (code: number) => {
        client.end()
        if (code !== 0) {
          reject(new Error(stderr || `exited with code ${code}`))
          return
        }
        resolve(stdout)
      })
    })
  })
}

// --- Public API ---

export async function exec(target: SshTarget, command: string): Promise<string> {
  if (typeof target === 'string') {
    return nativeExec(target, command)
  }
  return ssh2Exec(target, command)
}

export async function upload(target: SshTarget, remotePath: string, stream: Readable): Promise<void> {
  if (typeof target === 'string') {
    return new Promise((resolve, reject) => {
      const proc = sshSpawn(target, `cat > '${remotePath}'`, 'pipe-stdin')

      let stderr = ''
      proc.stderr!.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `ssh upload exited with code ${code}`))
          return
        }
        resolve()
      })
      proc.on('error', reject)

      stream.pipe(proc.stdin!)
    })
  }

  const client = await connectSsh2(target)
  const sftp = await openSftp(client)

  await new Promise<void>((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath)
    ws.on('close', () => resolve())
    ws.on('error', reject)
    stream.pipe(ws)
  })

  client.end()
}

export async function download(target: SshTarget, remotePath: string): Promise<Buffer> {
  if (typeof target === 'string') {
    return new Promise((resolve, reject) => {
      const proc = sshSpawn(target, `cat '${remotePath}'`, 'pipe-all')

      const chunks: Buffer[] = []
      let stderr = ''
      proc.stdout!.on('data', (d: Buffer) => {
        chunks.push(d)
      })
      proc.stderr!.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `ssh download exited with code ${code}`))
          return
        }
        resolve(Buffer.concat(chunks))
      })
      proc.on('error', reject)
    })
  }

  const client = await connectSsh2(target)
  const sftp = await openSftp(client)

  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    const rs = sftp.createReadStream(remotePath)
    rs.on('data', (chunk: Buffer) => chunks.push(chunk))
    rs.on('end', () => resolve(Buffer.concat(chunks)))
    rs.on('error', reject)
  })

  client.end()
  return data
}

// --- SFTP operations ---

async function withSftp<T>(creds: SshCredentials, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const client = await connectSsh2(creds)
  const sftp = await openSftp(client)
  const result = await fn(sftp)
  client.end()
  return result
}

export const sftp = {
  async list(creds: SshCredentials, dirPath: string): Promise<SftpEntry[]> {
    return withSftp(
      creds,
      (s) =>
        new Promise((resolve, reject) => {
          s.readdir(dirPath, (err, list) => {
            if (err) {
              reject(err)
              return
            }
            resolve(
              list
                .filter((item) => item.filename !== '.' && item.filename !== '..')
                .map((item) => ({
                  name: item.filename,
                  isDirectory: item.attrs.isDirectory(),
                  size: item.attrs.size,
                  mtime: item.attrs.mtime,
                })),
            )
          })
        }),
    )
  },

  async read(creds: SshCredentials, filePath: string): Promise<Buffer> {
    return withSftp(
      creds,
      (s) =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = []
          const rs = s.createReadStream(filePath)
          rs.on('data', (chunk: Buffer) => chunks.push(chunk))
          rs.on('end', () => resolve(Buffer.concat(chunks)))
          rs.on('error', reject)
        }),
    )
  },

  async write(creds: SshCredentials, filePath: string, data: Buffer): Promise<void> {
    return withSftp(
      creds,
      (s) =>
        new Promise((resolve, reject) => {
          const ws = s.createWriteStream(filePath)
          ws.on('close', () => resolve())
          ws.on('error', reject)
          ws.end(data)
        }),
    )
  },

  async remove(creds: SshCredentials, filePath: string): Promise<void> {
    return withSftp(
      creds,
      (s) =>
        new Promise((resolve, reject) => {
          s.unlink(filePath, (err) => {
            if (err) {
              reject(err)
              return
            }
            resolve()
          })
        }),
    )
  },

  async rename(creds: SshCredentials, oldPath: string, newPath: string): Promise<void> {
    return withSftp(
      creds,
      (s) =>
        new Promise((resolve, reject) => {
          s.rename(oldPath, newPath, (err) => {
            if (err) {
              reject(err)
              return
            }
            resolve()
          })
        }),
    )
  },

  async mkdir(creds: SshCredentials, dirPath: string): Promise<void> {
    return withSftp(
      creds,
      (s) =>
        new Promise((resolve, reject) => {
          s.mkdir(dirPath, (err) => {
            if (err) {
              reject(err)
              return
            }
            resolve()
          })
        }),
    )
  },
}

// --- Interactive shell ---

export interface SshShell {
  onData: (fn: (data: string) => void) => void
  onClose: (fn: () => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

export async function shell(creds: SshCredentials, cols: number, rows: number, command?: string): Promise<SshShell> {
  const client = await connectSsh2(creds)

  return new Promise((resolve, reject) => {
    const onChannel = (err: Error | undefined, channel: import('ssh2').ClientChannel) => {
      if (err) {
        client.end()
        reject(err)
        return
      }
      resolve({
        onData(fn) {
          channel.on('data', (data: Buffer) => fn(data.toString('utf-8')))
          channel.stderr.on('data', (data: Buffer) => fn(data.toString('utf-8')))
        },
        onClose(fn) {
          channel.on('close', fn)
        },
        write(data) {
          channel.write(data)
        },
        resize(c, r) {
          channel.setWindow(r, c, r * 16, c * 8)
        },
        close() {
          channel.close()
          client.end()
        },
      })
    }
    if (command) {
      client.exec(command, { pty: { cols, rows, term: 'xterm-256color' } }, onChannel)
      return
    }
    client.shell({ cols, rows, term: 'xterm-256color' }, onChannel)
  })
}
