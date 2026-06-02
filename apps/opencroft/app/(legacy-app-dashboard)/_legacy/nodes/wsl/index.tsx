'use client'

import { Badge } from '@opencroft/ui-kit/badge'
import { Input } from '@opencroft/ui-kit/input'
import { Label } from '@opencroft/ui-kit/label'
import { type Node, type NodeProps, useReactFlow } from '@xyflow/react'
import { Cpu, FolderOpen, HardDrive, MemoryStick, Monitor, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { NodeSettingsProps, NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { useSettingsDraft } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/use-settings-draft'
import { ButtonPin, HANDLE_EXECUTION, HANDLE_FILESYSTEM } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/button-pin'
import { PinnedNode, StatsList } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/pinned-node'
import { spawnFileBrowserWindow, spawnTerminalWindow } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/spawn-window'
import { getWslStats, type WslStats } from '@/app/(legacy-app-dashboard)/_legacy/nodes/wsl/actions'

export type WslData = {
  distro: string
}

export type WslNode = Node<WslData, 'wsl'>

function WslComponent({ data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<WslNode>) {
  const { setNodes } = useReactFlow()
  const [stats, setStats] = useState<WslStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!data.distro) {
      return
    }
    setLoading(true)
    setError(false)
    getWslStats({ data: data.distro })
      .then((s) => {
        setStats(s)
        setLoading(false)
      })
      .catch(() => {
        setError(true)
        setLoading(false)
      })
  }, [data.distro])

  const openTerminal = useCallback(() => {
    if (!data.distro) {
      return
    }
    setNodes((nds) => [...nds, spawnTerminalWindow({ title: data.distro, x: positionAbsoluteX, y: positionAbsoluteY }, { type: 'wsl', config: { distro: data.distro } })])
  }, [data.distro, positionAbsoluteX, positionAbsoluteY, setNodes])

  const openFiles = useCallback(() => {
    if (!data.distro) {
      return
    }
    setNodes((nds) => [
      ...nds,
      spawnFileBrowserWindow(
        { title: data.distro, x: positionAbsoluteX, y: positionAbsoluteY },
        {
          id: `wsl:${data.distro}`,
          name: data.distro,
          type: 'wsl',
          config: { distro: data.distro, basePath: '/' },
        },
      ),
    ])
  }, [data.distro, positionAbsoluteX, positionAbsoluteY, setNodes])

  const status = loading ? ('warning' as const) : error ? ('destructive' as const) : stats ? ('success' as const) : undefined

  return (
    <PinnedNode
      selected={selected}
      loading={loading}
      accent='oklch(0.65 0.2 30)'
      icon={TerminalSquare}
      iconClassName='text-orange-400'
      status={status}
      title={data.distro || 'WSL'}
      extra={
        <Badge variant='outline' className='text-[9px] h-4'>
          WSL
        </Badge>
      }
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
        data.distro ? (
          <>
            <ButtonPin handleId={HANDLE_EXECUTION} icon={TerminalSquare} label='Terminal' side='right' onClick={openTerminal} />
            <ButtonPin handleId={HANDLE_FILESYSTEM} icon={FolderOpen} label='Files' side='right' onClick={openFiles} />
          </>
        ) : undefined
      }
    />
  )
}

function WslSettings(props: NodeSettingsProps<WslData>) {
  const { draft, update } = useSettingsDraft(props)

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Distro</Label>
        <Input value={draft.distro ?? ''} onChange={(e) => update({ distro: e.target.value })} placeholder='Ubuntu' className='h-7 text-xs font-mono' />
      </div>
    </div>
  )
}

export const wslDefinition: NodeTypeDefinition<WslData> = {
  type: 'wsl',
  label: 'WSL',
  icon: TerminalSquare,
  group: 'Infrastructure',
  defaultData: () => ({ distro: '' }),
  component: WslComponent,
  settings: WslSettings,
}
