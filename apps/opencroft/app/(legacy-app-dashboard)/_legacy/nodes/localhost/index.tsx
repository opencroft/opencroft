'use client'

import { type Node, type NodeProps, useReactFlow } from '@xyflow/react'
import { Cpu, FolderOpen, HardDrive, MemoryStick, Monitor, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { NodeSettingsProps, NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { getLocalhostStats, type LocalhostStats } from '@/app/(legacy-app-dashboard)/_legacy/nodes/localhost/actions'
import {
  ButtonPin,
  HANDLE_EXECUTION,
  HANDLE_FILESYSTEM,
} from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/button-pin'
import { PinnedNode, StatsList } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/pinned-node'
import {
  spawnFileBrowserWindow,
  spawnTerminalWindow,
} from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/spawn-window'

export type LocalhostData = Record<string, never>
export type LocalhostNode = Node<LocalhostData, 'localhost'>

function LocalhostComponent({ selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<LocalhostNode>) {
  const { setNodes } = useReactFlow()
  const [stats, setStats] = useState<LocalhostStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getLocalhostStats()
      .then((s) => {
        setStats(s)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const openTerminal = useCallback(() => {
    setNodes((nds) => [
      ...nds,
      spawnTerminalWindow(
        { title: 'Localhost', x: positionAbsoluteX, y: positionAbsoluteY },
        { type: 'local', config: {} },
      ),
    ])
  }, [positionAbsoluteX, positionAbsoluteY, setNodes])

  const openFiles = useCallback(() => {
    setNodes((nds) => [
      ...nds,
      spawnFileBrowserWindow(
        { title: 'Localhost', x: positionAbsoluteX, y: positionAbsoluteY },
        {
          id: 'localhost',
          name: 'Localhost',
          type: 'ssh',
          config: { host: 'localhost', port: 22, username: 'root', basePath: '/' },
        },
      ),
    ])
  }, [positionAbsoluteX, positionAbsoluteY, setNodes])

  const status = loading ? ('warning' as const) : stats ? ('success' as const) : ('destructive' as const)

  return (
    <PinnedNode
      selected={selected}
      loading={loading}
      accent='oklch(0.7 0.15 200)'
      icon={Monitor}
      iconClassName='text-cyan-400'
      status={status}
      title={stats?.hostname || 'Localhost'}
      subtitle={stats?.platform}
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
        ) : undefined
      }
      output={
        <>
          <ButtonPin
            handleId={HANDLE_EXECUTION}
            icon={TerminalSquare}
            label='Terminal'
            side='right'
            onClick={openTerminal}
          />
          <ButtonPin handleId={HANDLE_FILESYSTEM} icon={FolderOpen} label='Files' side='right' onClick={openFiles} />
        </>
      }
    />
  )
}

function LocalhostSettings({ onDirtyChange, onLoadingChange }: NodeSettingsProps<LocalhostData>) {
  const [stats, setStats] = useState<LocalhostStats | null>(null)

  useEffect(() => {
    onLoadingChange(true)
    getLocalhostStats().then((s) => {
      setStats(s)
      onLoadingChange(false)
    })
  }, [])

  useEffect(() => {
    onDirtyChange(false, () => {})
  }, [onDirtyChange])

  if (!stats) {
    return null
  }

  return (
    <div className='flex flex-col gap-2'>
      {[
        { label: 'Hostname', value: stats.hostname },
        { label: 'OS', value: stats.os },
        { label: 'Platform', value: stats.platform },
        { label: 'CPU', value: stats.cpu },
        { label: 'Memory', value: stats.memory },
        { label: 'Storage', value: stats.storage },
      ].map((item) => (
        <div key={item.label} className='flex justify-between text-xs'>
          <span className='text-muted-foreground'>{item.label}</span>
          <span className='font-mono'>{item.value}</span>
        </div>
      ))}
    </div>
  )
}

export const localhostDefinition: NodeTypeDefinition<LocalhostData> = {
  type: 'localhost',
  label: 'Localhost',
  icon: Monitor,
  group: 'Infrastructure',
  defaultData: () => ({}),
  component: LocalhostComponent,
  settings: LocalhostSettings,
}
