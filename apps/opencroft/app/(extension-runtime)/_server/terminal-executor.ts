import { execFile } from 'node:child_process'

import { exec } from '@/server/shell'

// ── Types ────────────────────────────────────────────────────────────

export type TerminalContext = { type: 'local' } | { type: 'wsl'; distro: string } | { type: 'ssh'; host: string; port: number; username: string; password?: string; privateKey?: string }

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

// ── Local execution ──────────────────────────────────────────────────

async function execLocal(command: string): Promise<ExecResult> {
  try {
    const stdout = await exec(command)
    return { exitCode: 0, stdout, stderr: '' }
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string }
    return {
      exitCode: (err as { code?: number }).code ?? 1,
      stdout: '',
      stderr: error.stderr ?? error.message,
    }
  }
}

// ── WSL execution ────────────────────────────────────────────────────

async function execWsl(distro: string, command: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = ['-d', distro, '--exec', 'bash', '-c', command]
    const opts = { maxBuffer: 50 * 1024 * 1024, windowsHide: true }

    execFile('wsl', args, opts, (err, stdout, stderr) => {
      const exitCode = err ? ((err as unknown as { status?: number }).status ?? 1) : 0
      resolve({
        exitCode,
        stdout: stdout ?? '',
        stderr: stderr ?? err?.message ?? '',
      })
    })
  })
}

// ── SSH execution ────────────────────────────────────────────────────

async function execSsh(ctx: TerminalContext & { type: 'ssh' }, command: string): Promise<ExecResult> {
  const { Client } = await import('ssh2')
  return new Promise((resolve) => {
    const client = new Client()
    let stdout = ''
    let stderr = ''

    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          client.end()
          resolve({ exitCode: 1, stdout: '', stderr: err.message })
          return
        }
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        stream.on('close', (code: number) => {
          client.end()
          resolve({ exitCode: code ?? 0, stdout, stderr })
        })
      })
    })

    client.on('error', (err) => {
      resolve({ exitCode: 1, stdout: '', stderr: err.message })
    })

    const connectOptions: Record<string, unknown> = {
      host: ctx.host,
      port: ctx.port || 22,
      username: ctx.username || 'root',
      readyTimeout: 10000,
    }
    if (ctx.password) {
      connectOptions.password = ctx.password
    }
    if (ctx.privateKey) {
      connectOptions.privateKey = ctx.privateKey
    }
    client.connect(connectOptions)
  })
}

// ── Public API ───────────────────────────────────────────────────────

export async function executeInContext(ctx: TerminalContext, command: string): Promise<ExecResult> {
  switch (ctx.type) {
    case 'local':
      return execLocal(command)
    case 'wsl':
      return execWsl(ctx.distro, command)
    case 'ssh':
      return execSsh(ctx, command)
    default:
      return { exitCode: 1, stdout: '', stderr: `Unknown terminal context type: ${(ctx as { type: string }).type}` }
  }
}
