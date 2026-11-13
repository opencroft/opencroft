import type { TerminalConfig } from '../types'

/** Quote a value for the single shell-string composition below (the wsl/local branches pass argv arrays instead, so they need no quoting). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function shellJoin(args: string[]): string {
  return args.map((arg) => (/^[\w./:@=,-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ')
}

// Portable fallback when the docker-exec context doesn't specify a preferred shell: try bash,
// falling back to sh, since minimal images (alpine, busybox) have no bash. This is the inner
// command run by the outer `sh -lc` below.
const SHELL_FALLBACK_INNER = `command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l`

function flattenDockerExec(value: Record<string, unknown>): TerminalConfig {
  const via = (value.via as Record<string, unknown> | undefined) ?? { type: 'local' }
  const contextName = value.contextName as string | undefined
  const containerId = value.containerId as string
  const cwd = value.cwd as string | undefined
  const user = value.user as string | undefined
  const shell = value.shell as string | undefined
  const ctxArgs = contextName ? ['--context', contextName] : []
  const cwdArgs = cwd ? ['-w', cwd] : []
  const userArgs = user ? ['-u', user] : []
  // Always run through `sh -lc '<inner>'` so the fallback probe (or the explicit shell exec) runs
  // as a login shell inside the container; `inner` is a single argv element, quoted as a whole by
  // shellQuote/shellJoin below for the ssh branch (it contains no embedded single quotes).
  const inner = shell ? `exec ${shell} -l` : SHELL_FALLBACK_INNER
  const execArgs = [...ctxArgs, 'exec', ...cwdArgs, ...userArgs, '-it', containerId, 'sh', '-lc', inner]
  if (via.type === 'ssh') {
    const { type: _t, ...config } = via
    // The ssh branch collapses execArgs into one shell string (unlike wsl/local below, which
    // pass argv arrays), so any element containing spaces/quotes (e.g. a `cwd` with a space)
    // must be shell-quoted or it silently breaks the composed `docker exec` invocation.
    return { type: 'ssh', config: { ...config, command: `docker ${shellJoin(execArgs)}` } } as TerminalConfig
  }
  if (via.type === 'wsl') {
    const { type: _t, ...config } = via
    return { type: 'wsl', config: { ...config, command: 'docker', args: execArgs } }
  }
  return { type: 'local', config: { command: 'docker', args: execArgs } }
}

/**
 * A terminal-context value (what a `terminal-context` handle carries: local, wsl, ssh or
 * docker-exec) as the connection the `Terminal` component opens. A docker-exec context becomes a
 * `docker exec -it` through its parent context, running the context's shell, else bash where the
 * container has it and sh where it doesn't, as its user and in its working directory when given.
 */
export function connectionFromContext(value: Record<string, unknown> | undefined): TerminalConfig | null {
  if (!value) {
    return null
  }
  if (value.type === 'docker-exec') {
    return flattenDockerExec(value)
  }
  const { type, ...config } = value
  return { type: (type as TerminalConfig['type']) ?? 'local', config } as TerminalConfig
}
