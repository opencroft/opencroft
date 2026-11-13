import { invoke } from '@opencroft/client/actions'
import { inspectorIntent, NodeFrame, OutputHandle } from '@opencroft/client/canvas'
import { Terminal } from '@opencroft/client/terminal'
import { Cpu, HardDrive, MemoryStick, Monitor, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { InspectorFilesBody, PinButton, PinnedBody, StatsList } from '../shared'

interface LocalhostStats {
  os: string
  cpu: string
  memory: string
  storage: string
  hostname: string
  platform: string
}

export function LocalhostNode({
  id,
  data,
  selected,
}: {
  id: string
  data: Record<string, unknown>
  selected?: boolean
}) {
  void data
  const [stats, setStats] = useState<LocalhostStats | null>(null)

  useEffect(() => {
    invoke<LocalhostStats>('localhost.getStats')
      .then(setStats)
      .catch(() => null)
  }, [])

  const openInspector = useCallback(
    (tab: string) => {
      inspectorIntent.open(id, tab)
    },
    [id],
  )

  const openTerminal = useCallback(() => openInspector('terminal'), [openInspector])

  return (
    <NodeFrame
      icon={Monitor}
      title={stats?.hostname || 'Localhost'}
      subtitle={stats?.platform}
      status={stats ? 'success' : 'neutral'}
      selected={selected ?? false}
    >
      <PinnedBody
        input={
          stats ? (
            <StatsList
              items={[
                { icon: Monitor, value: stats.os },
                { icon: Cpu, value: stats.cpu },
                { icon: MemoryStick, value: stats.memory },
                { icon: HardDrive, value: stats.storage },
              ]}
            />
          ) : (
            <div className='text-[10px] text-muted-foreground italic'>loading stats…</div>
          )
        }
        output={
          <OutputHandle type='terminal-context' id='terminal'>
            <PinButton icon={TerminalSquare} label='Terminal' onClick={openTerminal} />
          </OutputHandle>
        }
      />
    </NodeFrame>
  )
}

export function LocalhostInspector() {
  const [stats, setStats] = useState<LocalhostStats | null>(null)

  useEffect(() => {
    invoke<LocalhostStats>('localhost.getStats')
      .then(setStats)
      .catch(() => null)
  }, [])

  if (!stats) {
    return <div className='text-xs text-muted-foreground italic'>Loading…</div>
  }

  const rows = [
    ['Hostname', stats.hostname],
    ['OS', stats.os],
    ['Platform', stats.platform],
    ['CPU', stats.cpu],
    ['Memory', stats.memory],
    ['Storage', stats.storage],
  ]

  return (
    <div className='flex flex-col gap-2'>
      {rows.map(([label, value]) => (
        <div key={label} className='flex justify-between text-xs'>
          <span className='text-muted-foreground'>{label}</span>
          <span className='font-mono'>{value}</span>
        </div>
      ))}
    </div>
  )
}

export function LocalhostTerminalTab() {
  return <Terminal connection={{ type: 'local', config: {} }} />
}

export function LocalhostFilesTab() {
  return (
    <InspectorFilesBody
      connection={{
        id: 'localhost',
        name: 'Localhost',
        type: 'ssh',
        config: { host: 'localhost', port: 22, username: 'root', basePath: '/' },
      }}
    />
  )
}
