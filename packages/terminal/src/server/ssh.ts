import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'

import type { ExecOptions, ExecResult, ServerConfig, SshCredentials } from '../types'
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, OutputCollector } from './exec-util'
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
      readyTimeout: 10000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    })
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err)
        return
      }
      resolve(sftp)
    })
  })
}

// --- Connection pool ---
//
// Every ssh2 entry point (one-shot exec, sftp, upload/download, interactive shell) shares one
// `Client` per (host, port, username, auth) key instead of dialing fresh each time. `acquire()`
// bumps a ref count and cancels any pending idle-close timer; `release()` drops the ref count and,
// once it hits zero, arms a 60s idle timer that ends the client — this is what lets a long-lived
// `shell()` session keep its client alive for as long as the channel is open, while short-lived
// `exec`/`sftp` calls don't each pay a fresh TCP+SSH handshake.
//
// Native `ssh <alias>` spawns (string targets) go through OpenSSH's own connection, not this pool.

const POOL_IDLE_MS = 60_000

interface PoolEntry {
  client: Client
  activeChannels: number
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

const pool = new Map<string, PoolEntry>()
const pendingDials = new Map<string, Promise<Client>>()

/** Fingerprint the auth material without ever putting a plaintext password in the map key. */
function authFingerprint(creds: SshCredentials): string {
  if (creds.keyPath) {
    return `key:${creds.keyPath}`
  }
  if (creds.password) {
    return `pw:${createHash('sha256').update(creds.password).digest('hex')}`
  }
  return 'none'
}

function poolKey(creds: SshCredentials): string {
  return `${creds.host}:${creds.port || 22}:${creds.username}:${authFingerprint(creds)}`
}

function armIdleTimer(key: string, entry: PoolEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
  }
  entry.idleTimer = setTimeout(() => {
    if (pool.get(key) === entry && entry.activeChannels === 0) {
      entry.client.end()
    }
  }, POOL_IDLE_MS)
  entry.idleTimer.unref?.()
}

function bumpActive(entry: PoolEntry): void {
  entry.activeChannels += 1
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }
}

function evict(key: string, entry: PoolEntry): void {
  if (pool.get(key) === entry) {
    pool.delete(key)
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
  }
}

function dial(key: string, creds: SshCredentials): Promise<Client> {
  const dialPromise = connectSsh2(creds).then((client) => {
    const entry: PoolEntry = { client, activeChannels: 0, idleTimer: undefined }
    pool.set(key, entry)
    const onGone = () => evict(key, entry)
    client.on('error', onGone)
    client.on('close', onGone)
    client.on('end', onGone)
    return client
  })
  pendingDials.set(key, dialPromise)
  dialPromise.finally(() => {
    if (pendingDials.get(key) === dialPromise) {
      pendingDials.delete(key)
    }
  })
  return dialPromise
}

/** Acquire a pooled, ready `Client` for `creds` — reuses a live connection or dials a new one. */
async function acquire(creds: SshCredentials): Promise<Client> {
  const key = poolKey(creds)

  const existing = pool.get(key)
  if (existing) {
    bumpActive(existing)
    return existing.client
  }

  const client = await (pendingDials.get(key) ?? dial(key, creds))

  const entry = pool.get(key)
  if (entry) {
    bumpActive(entry)
  }
  return client
}

/** Release a channel obtained via `acquire`; arms the idle-close timer once refs reach zero. */
function release(creds: SshCredentials): void {
  const key = poolKey(creds)
  const entry = pool.get(key)
  if (!entry) {
    return
  }
  entry.activeChannels = Math.max(0, entry.activeChannels - 1)
  if (entry.activeChannels === 0) {
    armIdleTimer(key, entry)
  }
}

/** Ends every pooled connection immediately. For tests/shutdown. */
export function closeAllSshPools(): void {
  for (const [key, entry] of pool) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
    }
    entry.client.end()
    pool.delete(key)
  }
  pendingDials.clear()
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
  const client = await acquire(creds)

  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) {
        release(creds)
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
        release(creds)
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
 * Transport-level one-shot exec: connects, runs `command`, and resolves with an `ExecResult`
 * for any command that ran — non-zero exit codes are NOT a rejection. Rejects only on
 * connect/auth/exec failures. Enforces `timeoutMs` (closing the channel) and caps each stream
 * at `maxOutputBytes`, matching every other `TerminalBackend`.
 */
export async function sshExecResult(
  creds: SshCredentials,
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  const client = await acquire(creds)

  return new Promise<ExecResult>((resolve, reject) => {
    const stdout = new OutputCollector(maxBytes)
    const stderr = new OutputCollector(maxBytes)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
      }
    }

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimer()
        release(creds)
        reject(err)
        return
      }
      // Out-of-band env delivery (see buildEnvInjection): write once, then end the channel's
      // writable side so a preamble's `read` sees EOF right after its own lines. Every other
      // caller leaves the channel's stdin untouched, exactly as before this existed.
      if (opts.stdin) {
        stream.end(opts.stdin)
      }
      timer = setTimeout(() => {
        timedOut = true
        stream.close()
      }, timeoutMs)
      stream.on('data', (chunk: Buffer) => stdout.push(chunk))
      stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      stream.on('close', (code: number | null) => {
        clearTimer()
        release(creds)
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: timedOut ? 124 : (code ?? 1),
          truncated: stdout.truncated || stderr.truncated || undefined,
          stdoutTruncated: stdout.truncated || undefined,
          timedOut: timedOut || undefined,
        })
      })
    })
  })
}

/** One-shot exec against a `ServerConfig`. Throws (with exit code + stderr) on non-zero exit. */
export async function sshExec(config: ServerConfig, command: string): Promise<string> {
  const result = await sshExecResult(
    {
      host: config.address,
      port: config.port,
      username: config.username,
      password: config.password,
      keyPath: config.keyPath,
    },
    command,
  )
  if (result.exitCode !== 0) {
    const suffix = result.stderr ? `: ${result.stderr}` : ''
    throw new Error(`ssh exited with code ${result.exitCode}${suffix}`)
  }
  return result.stdout
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

  const client = await acquire(target)
  try {
    const sftp = await openSftp(client)
    await new Promise<void>((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath)
      ws.on('close', () => resolve())
      ws.on('error', reject)
      stream.pipe(ws)
    })
  } finally {
    release(target)
  }
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

  const client = await acquire(target)
  try {
    const sftp = await openSftp(client)
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const rs = sftp.createReadStream(remotePath)
      rs.on('data', (chunk: Buffer) => chunks.push(chunk))
      rs.on('end', () => resolve(Buffer.concat(chunks)))
      rs.on('error', reject)
    })
    return data
  } finally {
    release(target)
  }
}

// --- SFTP operations ---

async function withSftp<T>(creds: SshCredentials, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const client = await acquire(creds)
  try {
    const sftp = await openSftp(client)
    return await fn(sftp)
  } finally {
    release(creds)
  }
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
  const client = await acquire(creds)

  return new Promise((resolve, reject) => {
    // The shared client must stay open for as long as this interactive channel lives, so we hold
    // one pool ref for the whole session and only release() it once — never end() the client
    // directly, since other exec/sftp calls may be sharing it.
    let released = false
    const releaseOnce = () => {
      if (!released) {
        released = true
        release(creds)
      }
    }

    const onChannel = (err: Error | undefined, channel: ClientChannel) => {
      if (err) {
        releaseOnce()
        reject(err)
        return
      }
      resolve({
        onData(fn) {
          channel.on('data', (data: Buffer) => fn(data.toString('utf-8')))
          channel.stderr.on('data', (data: Buffer) => fn(data.toString('utf-8')))
        },
        onClose(fn) {
          channel.on('close', () => {
            releaseOnce()
            fn()
          })
        },
        write(data) {
          channel.write(data)
        },
        resize(c, r) {
          channel.setWindow(r, c, r * 16, c * 8)
        },
        close() {
          channel.close()
          releaseOnce()
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
