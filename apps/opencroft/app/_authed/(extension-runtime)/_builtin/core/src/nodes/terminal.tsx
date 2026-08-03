import { InputHandle, icons, React, useNodeContext } from '@ext/host'
import { Terminal } from '@ext/ui'

import { WindowShell } from '../shared'

const { useState } = React

interface WindowData {
  title: string
  connection?: TerminalConnection
  /** Bumped by the inspector's "Restart session" button to force a fresh shell. */
  restartNonce?: number
}

interface TerminalConnection {
  type: 'ssh' | 'local' | 'wsl'
  config: Record<string, unknown>
}

/** Quote a value for the single shell-string composition below (the wsl/local branches pass argv arrays instead, so they need no quoting). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function shellJoin(args: string[]): string {
  return args.map((arg) => (/^[\w./:@=,-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ')
}

// Portable fallback when the docker-exec context doesn't specify a preferred shell: try bash,
// falling back to sh, since minimal/distroless images may not have bash installed. This is the
// inner command run by the outer `sh -lc` below.
const SHELL_FALLBACK_INNER = `command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l`

function flattenDockerExec(value: Record<string, unknown>): TerminalConnection {
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
    return { type: 'ssh', config: { ...config, command: `docker ${shellJoin(execArgs)}` } }
  }
  if (via.type === 'wsl') {
    const { type: _t, ...config } = via
    return { type: 'wsl', config: { ...config, command: 'docker', args: execArgs } }
  }
  return { type: 'local', config: { command: 'docker', args: execArgs } }
}

function connectionFromContext(value: Record<string, unknown> | undefined): TerminalConnection | null {
  if (!value) {
    return null
  }
  if (value.type === 'docker-exec') {
    return flattenDockerExec(value)
  }
  const { type, ...config } = value
  return { type: (type as TerminalConnection['type']) ?? 'local', config }
}

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export function TerminalWindowNode({ id, data, selected }: { id: string; data: WindowData; selected?: boolean }) {
  const ctx = useNodeContext<Record<string, unknown>>(id, 'ssh-in')
  const connection: TerminalConnection | null = data.connection ?? connectionFromContext(ctx?.value)
  const [status, setStatus] = useState<TerminalStatus>('connecting')

  return (
    <WindowShell
      id={id}
      selected={selected}
      loading={connection !== null && status !== 'connected'}
      icon={icons.TerminalSquare}
      iconClassName='text-green-400'
      title={data.title || 'Terminal'}
      bodyClassName='bg-black'
      input={<InputHandle type='terminal-context' id='ssh-in' />}
    >
      {connection ? (
        <Terminal
          connection={connection}
          fontSize={13}
          sessionKey={id}
          restartToken={data.restartNonce}
          onStatusChange={setStatus}
        />
      ) : (
        <div className='p-3 text-[11px] text-muted-foreground italic'>
          Connect an SSH / WSL / Localhost node&apos;s terminal output to this window.
        </div>
      )}
    </WindowShell>
  )
}

export function TerminalWindowInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: WindowData
  updateData: (p: Partial<WindowData>) => void
}) {
  return (
    <div className='flex flex-col gap-2 text-xs'>
      <div className='font-medium'>{data.title || 'Terminal'}</div>
      {data.connection ? (
        <pre className='text-[10px] font-mono bg-muted rounded-sm p-2 overflow-x-auto'>
          {JSON.stringify(data.connection, null, 2)}
        </pre>
      ) : (
        <div className='text-muted-foreground italic'>No connection configured.</div>
      )}
      {data.connection ? (
        <button
          type='button'
          onClick={() => updateData({ restartNonce: Date.now() })}
          className='self-start px-2 py-1 rounded-sm bg-muted text-foreground hover:bg-muted/80'
        >
          Restart session
        </button>
      ) : null}
    </div>
  )
}
