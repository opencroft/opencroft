import { InputHandle, useNodeContext, WindowShell } from '@opencroft/client/canvas'
import { connectionFromContext, Terminal, type TerminalConfig } from '@opencroft/client/terminal'
import { TerminalSquare } from 'lucide-react'
import { useState } from 'react'

interface WindowData {
  title: string
  connection?: TerminalConfig
  /** Bumped by the inspector's "Restart session" button to force a fresh shell, for every viewer. */
  restartNonce?: number
}

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/**
 * The window is one shell on the canvas for everyone who opens the graph: all of them see it and
 * can type into it, and a reload joins it again. It ends when the node is removed, which is also
 * what the window's own close does; "Restart session" replaces it for everyone.
 */
export function TerminalWindowNode({ id, data, selected }: { id: string; data: WindowData; selected?: boolean }) {
  const ctx = useNodeContext<Record<string, unknown>>(id, 'ssh-in')
  const connection = data.connection ?? connectionFromContext(ctx?.value)
  const [status, setStatus] = useState<TerminalStatus>('connecting')

  return (
    <WindowShell
      id={id}
      selected={selected}
      loading={connection !== null && status !== 'connected'}
      icon={TerminalSquare}
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
          shared
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
