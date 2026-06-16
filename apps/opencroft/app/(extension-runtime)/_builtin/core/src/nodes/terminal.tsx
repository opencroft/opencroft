import { InputHandle, icons, React, useNodeContext } from '@ext/host'
import { Terminal } from '@ext/ui'

import { WindowShell } from '../shared'

const { useState } = React

interface WindowData {
  title: string
  connection?: TerminalConnection
}

interface TerminalConnection {
  type: 'ssh' | 'local' | 'wsl'
  config: Record<string, unknown>
}

function flattenDockerExec(value: Record<string, unknown>): TerminalConnection {
  const via = (value.via as Record<string, unknown> | undefined) ?? { type: 'local' }
  const contextName = value.contextName as string | undefined
  const containerId = value.containerId as string
  const ctxArgs = contextName ? ['--context', contextName] : []
  const execArgs = [...ctxArgs, 'exec', '-it', containerId, 'bash']
  if (via.type === 'ssh') {
    const { type: _t, ...config } = via
    return { type: 'ssh', config: { ...config, command: `docker ${execArgs.join(' ')}` } }
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
        <Terminal connection={connection} fontSize={13} onStatusChange={setStatus} />
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
    </div>
  )
}
