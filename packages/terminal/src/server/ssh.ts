import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'

import type { ServerConfig, SshCredentials } from '../types'
import { resolveKeyContent } from './keys'

export interface SftpEntry {
  name: string
  isDirectory: boolean
  size: number
  mtime: number
}

type SshTarget = string | SshCredentials

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

async function ssh2Exec(creds: SshCredentials, command: string): Promise<string> {
  const client = await connectSsh2(creds)

  return new Promise((resolve, reject) => {
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

/**
 * One-shot exec against a `ServerConfig`. Unlike `exec`, it tolerates non-zero
 * exit codes and only rejects when the command produced stderr with no stdout.
 */
export async function sshExec(config: ServerConfig, command: string): Promise<string> {
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
    const onChannel = (err: Error | undefined, channel: ClientChannel) => {
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
