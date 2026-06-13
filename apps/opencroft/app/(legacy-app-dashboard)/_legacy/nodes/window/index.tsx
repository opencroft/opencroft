'use client'

import type { TerminalConfig } from '@opencroft/terminal'
import { Terminal } from '@opencroft/terminal/client'
import { type NodeProps, useReactFlow } from '@xyflow/react'
import { AppWindow, FolderOpen, TerminalSquare, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Button } from 'ui/button'

import { FileBrowser } from '@/app/(filemanager)/_components/file-browser'
import { FileManagerProvider } from '@/app/(filemanager)/_components/filemanager-provider'
import type { StorageConnection } from '@/app/(filemanager)/_lib/types'
import { InvisibleResizer } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/invisible-resizer'
import { NodeCard, NodeCardHeader } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/node-card'

import '@/app/(legacy-app-dashboard)/_legacy/nodes/window/window.css'

export interface WindowNodeData extends Record<string, unknown> {
  title: string
  component: string
  props: Record<string, unknown>
}

const componentConfig: Record<string, { icon: typeof AppWindow; iconClass: string; accent: string; bg: string }> = {
  terminal: { icon: TerminalSquare, iconClass: 'text-green-400', accent: 'oklch(0.6 0.18 150)', bg: 'bg-black' },
  fileBrowser: { icon: FolderOpen, iconClass: 'text-amber-400', accent: 'oklch(0.7 0.15 80)', bg: 'bg-card' },
}

const defaultConfig = { icon: AppWindow, iconClass: 'text-blue-400', accent: 'oklch(0.6 0.15 250)', bg: 'bg-card' }

function WindowContent({ component, props }: { component: string; props: Record<string, unknown> }) {
  if (component === 'terminal') {
    return <Terminal connection={props.termConfig as TerminalConfig} fontSize={16} />
  }
  if (component === 'fileBrowser') {
    return (
      <FileManagerProvider initialConnection={props.connection as StorageConnection}>
        <FileBrowser />
      </FileManagerProvider>
    )
  }
  return <div className='text-xs text-muted-foreground p-2'>Unknown component: {component}</div>
}

export function WindowNodeComponent({ id, data: rawData, selected }: NodeProps) {
  const data = rawData as WindowNodeData
  const { setNodes } = useReactFlow()
  const config = componentConfig[data.component] ?? defaultConfig
  const Icon = config.icon
  const [closing, setClosing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
    }, 200)
  }, [id, setNodes])

  return (
    <>
      <InvisibleResizer id={id} />
      <div ref={ref} className={`h-full w-full ${closing ? 'window-node-close' : 'window-node-open'}`}>
        <NodeCard selected={selected} accent={config.accent} className='h-full w-full min-w-0 flex flex-col'>
          <NodeCardHeader
            icon={Icon}
            iconClassName={config.iconClass}
            title={data.title}
            extra={
              <Button variant='ghost' size='icon' className='nodrag nopan h-4 w-4' onClick={close}>
                <X className='h-3 w-3' />
              </Button>
            }
          />
          <div className={`flex-1 nodrag nopan nowheel overflow-hidden rounded-b-md mx-px mb-px relative ${config.bg}`}>
            <div className='absolute inset-2'>
              <WindowContent component={data.component} props={data.props} />
            </div>
          </div>
        </NodeCard>
      </div>
    </>
  )
}
