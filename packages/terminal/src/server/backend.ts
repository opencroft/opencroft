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
import { sshExecResult, sshStreamHandle } from './ssh'
import { type OutputFilter, pipedProcessHandle, type StreamHandle } from './stream-handle'

/** What a streamed command needs, which is the collecting options minus everything about
 *  collecting: there is no timeout or output cap here, because nothing is being accumulated. */
export interface StreamOptions {
  cwd?: string
  env?: Record<string, string>
  /**
   * Written to the command's stdin once, which is then closed. Safe for a document carrying
   * resolved secret values: every transport here is non-pty, so it is never echoed to a watcher.
   */
  stdin?: string
  /** Transforms the output before anything keeps or shows it — see OutputFilter. */
  filter?: OutputFilter
}

/**
 * The one execution abstraction every backend (local, wsl, ssh, docker-exec) implements.
 * `exec` runs a shell-interpreted command string; `run` runs an argv with no extra shell
 * interpretation where the backend can avoid it. Both resolve with an `ExecResult` for any
 * command that ran (non-zero exit is NOT a rejection) and reject only on transport/spawn
 * failures (connect refused, auth failure, binary missing).
 *
 * `stream` is the third, and it differs in kind rather than in options: it hands back a live
 * handle instead of a finished result, for a command whose output is wanted while it runs. It is
 * on this interface rather than beside it so that a caller with a context cannot reach a
 * streaming transport that does not match it — the mistake `exec`/`run` already make impossible.
 *
 * **Not every context implements it, and that is deliberate rather than unfinished.** A streamed
 * command needs a non-pty channel of the transport's own, and `wsl` and `docker-exec` have no
 * such channel here today. They refuse, naming the context, instead of falling back to a
 * transport that would run the command on the wrong machine.
 */
export interface TerminalBackend {
  exec(ctx: TerminalContext, command: string, opts?: ExecOptions): Promise<ExecResult>
  run(ctx: TerminalContext, argv: string[], opts?: ExecOptions): Promise<ExecResult>
  stream(ctx: TerminalContext, argv: string[], opts?: StreamOptions): Promise<StreamHandle>
}

/**
 * The refusal a context without a streaming channel gives.
 *
 * It names the context, because the caller passed one and the useful question is which of theirs
 * cannot do this — not that something, somewhere, is unimplemented.
 */
function notStreamable(type: string): never {
  throw new Error(
    `Streaming is not implemented for this context (${type}). A watchable session needs a non-pty ` +
      `channel per transport, and only local and ssh have one; a job on this context has to stay a ` +
      `one-shot exec until it does.`,
  )
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
  // On Windows "local" means the default WSL distro, and that is the wsl transport, which has no
  // streaming channel — so this refuses there rather than reaching for a pty and echoing the
  // command's own stdin back to everyone watching it.
  async stream(ctx, argv, opts = {}) {
    if (isWindows()) {
      notStreamable('local on Windows, which runs through wsl')
    }
    const [cmd, ...rest] = argv
    const child = nodeSpawn(cmd, rest, {
      cwd: opts.cwd ?? ctx.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // The handle is built before anything is written, because it is what installs the `'error'`
    // listeners. Writing first leaves a window where a child that failed to spawn raises an
    // unhandled stream error instead of becoming a session that ended and said why.
    const handle = pipedProcessHandle(child, opts.filter)
    child.stdin?.end(opts.stdin ?? '')
    return handle
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
  async stream() {
    notStreamable('wsl')
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
  async stream(ctx, argv, opts = {}) {
    const cwd = opts.cwd ?? ctx.cwd
    const { preamble, stdin: envStdin } = buildEnvInjection(opts.env)
    // Env and a stdin document want the same channel, and this is the one place they can both
    // turn up: env arrives out of band as lines the preamble reads from stdin, so a document sent
    // alongside would be read as part of that preamble's input. Refused rather than silently
    // preferring one — a deploy that lost its env, or a compose file that arrived truncated, is
    // the kind of failure that gets diagnosed as something else entirely.
    if (envStdin && opts.stdin !== undefined) {
      throw new Error(
        'ssh streaming cannot carry both `env` and `stdin`: env is delivered as lines the command ' +
          'reads from stdin before it starts, which is the same channel the stdin document uses. ' +
          'Send one or the other.',
      )
    }
    const full = cdPrefix(cwd) + preamble + shellJoin(argv)
    return sshStreamHandle(credsFromCtx(ctx), full, envStdin ?? opts.stdin, opts.filter)
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
  // Composing this the way `exec` and `run` do — `getBackend(via).stream(via, dockerArgv…)` — is
  // the obvious shape and it is not taken here. `docker exec -i` would inherit whichever channel
  // the parent context provides, so a `via` of `wsl` would compose into a refusal from one layer
  // down, naming the wrong context; and nothing on this path has been run against a real
  // docker-exec context. Deliberately left as a refusal that says so, rather than a composition
  // that looks finished.
  async stream() {
    notStreamable('docker-exec')
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
