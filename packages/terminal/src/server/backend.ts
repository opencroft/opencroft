import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import os from 'node:os'

import type { ExecOptions, ExecResult, SshCredentials, TerminalContext } from '../types'
import {
  buildEnvInjection,
  cdPrefix,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  OutputCollector,
  shellJoin,
} from './exec-util'
import { sshExecResult } from './ssh'

/**
 * The one execution abstraction every backend (local, wsl, ssh, docker-exec) implements.
 * `exec` runs a shell-interpreted command string; `run` runs an argv with no extra shell
 * interpretation where the backend can avoid it. Both resolve with an `ExecResult` for any
 * command that ran (non-zero exit is NOT a rejection) and reject only on transport/spawn
 * failures (connect refused, auth failure, binary missing).
 */
export interface TerminalBackend {
  exec(ctx: TerminalContext, command: string, opts?: ExecOptions): Promise<ExecResult>
  run(ctx: TerminalContext, argv: string[], opts?: ExecOptions): Promise<ExecResult>
}

function isWindows(): boolean {
  return os.platform() === 'win32'
}

function contextCwd(ctx: TerminalContext, opts: ExecOptions): string | undefined {
  return opts.cwd ?? ctx.cwd
}

/** Collects a spawned child process into an `ExecResult`, enforcing timeout + output caps. */
function collectProcess(child: ChildProcess, opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const stdout = new OutputCollector(maxBytes)
  const stderr = new OutputCollector(maxBytes)
  let timedOut = false

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL')
        }
      }, 2000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    // Out-of-band env delivery (see buildEnvInjection): write once, then close stdin so a
    // preamble's `read` sees EOF right after its own lines rather than hanging. Every other
    // caller leaves stdin untouched, exactly as before this existed.
    if (opts.stdin) {
      child.stdin?.end(opts.stdin)
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (err) => {
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      settled = true
      clearTimeout(timer)
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
}

// ═══════════════════════════════════════════════════════════════════
// local
// ═══════════════════════════════════════════════════════════════════

function spawnLocal(cmd: string, args: string[], cwd: string | undefined, opts: ExecOptions): ChildProcess {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env
  return nodeSpawn(cmd, args, { cwd, env, windowsHide: true })
}

// On Windows, "local" means "inside the default WSL distro" — same transport as `wslBackend`,
// so env must be injected the same way (stdin, not the spawned wsl.exe process's own env, which
// WSL does not forward into the distro).
function spawnLocalWindows(cmd: string, args: string[], cwd: string | undefined, preamble: string): ChildProcess {
  const cdArgs = cwd ? ['--cd', cwd] : []
  const invocation = preamble
    ? [...cdArgs, '--exec', 'bash', '-c', preamble + shellJoin([cmd, ...args])]
    : [...cdArgs, '--exec', cmd, ...args]
  return nodeSpawn('wsl', invocation, { windowsHide: true })
}

const localBackend: TerminalBackend = {
  exec(ctx, command, opts = {}) {
    const cwd = contextCwd(ctx, opts)
    if (isWindows()) {
      const { preamble, stdin } = buildEnvInjection(opts.env)
      return collectProcess(spawnLocalWindows('bash', ['-c', command], cwd, preamble), {
        ...opts,
        stdin: stdin ?? opts.stdin,
      })
    }
    return collectProcess(spawnLocal('bash', ['-c', command], cwd, opts), opts)
  },
  run(ctx, argv, opts = {}) {
    const cwd = contextCwd(ctx, opts)
    const [cmd, ...rest] = argv
    if (isWindows()) {
      const { preamble, stdin } = buildEnvInjection(opts.env)
      return collectProcess(spawnLocalWindows(cmd, rest, cwd, preamble), { ...opts, stdin: stdin ?? opts.stdin })
    }
    return collectProcess(spawnLocal(cmd, rest, cwd, opts), opts)
  },
}

// ═══════════════════════════════════════════════════════════════════
// wsl
// ═══════════════════════════════════════════════════════════════════

function wslArgs(ctx: TerminalContext, opts: ExecOptions): string[] {
  const distroArgs = ctx.distro ? ['-d', ctx.distro] : []
  const cwd = contextCwd(ctx, opts)
  const cdArgs = cwd ? ['--cd', cwd] : []
  return [...distroArgs, ...cdArgs]
}

const wslBackend: TerminalBackend = {
  exec(ctx, command, opts = {}) {
    const { preamble, stdin } = buildEnvInjection(opts.env)
    const child = nodeSpawn('wsl', [...wslArgs(ctx, opts), '--exec', 'bash', '-c', preamble + command], {
      windowsHide: true,
    })
    return collectProcess(child, { ...opts, stdin: stdin ?? opts.stdin })
  },
  run(ctx, argv, opts = {}) {
    const { preamble, stdin } = buildEnvInjection(opts.env)
    const args = preamble
      ? [...wslArgs(ctx, opts), '--exec', 'bash', '-c', preamble + shellJoin(argv)]
      : [...wslArgs(ctx, opts), '--exec', ...argv]
    return collectProcess(nodeSpawn('wsl', args, { windowsHide: true }), { ...opts, stdin: stdin ?? opts.stdin })
  },
}

// ═══════════════════════════════════════════════════════════════════
// ssh
// ═══════════════════════════════════════════════════════════════════

function credsFromCtx(ctx: TerminalContext): SshCredentials {
  return {
    host: ctx.host as string,
    port: (ctx.port as number) || 22,
    username: (ctx.username as string) || 'root',
    password: ctx.password as string | undefined,
    keyPath: ctx.keyPath as string | undefined,
  }
}

const sshBackend: TerminalBackend = {
  exec(ctx, command, opts = {}) {
    const cwd = contextCwd(ctx, opts)
    const { preamble, stdin } = buildEnvInjection(opts.env)
    const full = cdPrefix(cwd) + preamble + command
    return sshExecResult(credsFromCtx(ctx), full, { ...opts, stdin: stdin ?? opts.stdin })
  },
  run(ctx, argv, opts = {}) {
    const cwd = contextCwd(ctx, opts)
    const { preamble, stdin } = buildEnvInjection(opts.env)
    const full = cdPrefix(cwd) + preamble + shellJoin(argv)
    return sshExecResult(credsFromCtx(ctx), full, { ...opts, stdin: stdin ?? opts.stdin })
  },
}

// ═══════════════════════════════════════════════════════════════════
// docker-exec — composes with the parent (`ctx.via`) backend; no ssh/local/wsl logic here.
// ═══════════════════════════════════════════════════════════════════

function dockerArgv(ctx: TerminalContext, opts: ExecOptions): string[] {
  const ctxArgs = ctx.contextName ? ['--context', ctx.contextName as string] : []
  const cwd = contextCwd(ctx, opts)
  const cwdArgs = cwd ? ['-w', cwd] : []
  // ctx.shell (preferred interactive shell) does NOT affect one-shot exec/run: those always run
  // via `sh -c` for POSIX-safe argument handling, regardless of the user's interactive shell.
  const userArgs = typeof ctx.user === 'string' && ctx.user ? ['-u', ctx.user] : []
  return ['docker', ...ctxArgs, 'exec', ...cwdArgs, ...userArgs, '-i', (ctx.containerId as string) ?? '']
}

// Only the timeout/output-cap knobs travel to the parent call as opts -- cwd/env are consumed
// here, folded into the inner `sh -c` preamble. `stdin` is the one exception: it's how that
// preamble's payload actually reaches the container (the outer `docker exec -i` process forwards
// its own stdin straight through), so it has to ride along on the parent call explicitly.
function parentOpts(opts: ExecOptions, stdin: Buffer | undefined): ExecOptions {
  return { timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes, stdin }
}

const dockerExecBackend: TerminalBackend = {
  exec(ctx, command, opts = {}) {
    const via = ctx.via ?? { type: 'local' }
    const { preamble, stdin } = buildEnvInjection(opts.env)
    const argv = [...dockerArgv(ctx, opts), 'sh', '-c', preamble + command]
    return getBackend(via).run(via, argv, parentOpts(opts, stdin))
  },
  run(ctx, argv, opts = {}) {
    const via = ctx.via ?? { type: 'local' }
    const { preamble, stdin } = buildEnvInjection(opts.env)
    const innerArgv = preamble ? ['sh', '-c', preamble + shellJoin(argv)] : argv
    const fullArgv = [...dockerArgv(ctx, opts), ...innerArgv]
    return getBackend(via).run(via, fullArgv, parentOpts(opts, stdin))
  },
}

// ═══════════════════════════════════════════════════════════════════
// dispatcher
// ═══════════════════════════════════════════════════════════════════

export function getBackend(ctx: TerminalContext): TerminalBackend {
  switch (ctx.type) {
    case 'ssh':
      return sshBackend
    case 'wsl':
      return wslBackend
    case 'docker-exec':
      return dockerExecBackend
    default:
      return localBackend
  }
}
