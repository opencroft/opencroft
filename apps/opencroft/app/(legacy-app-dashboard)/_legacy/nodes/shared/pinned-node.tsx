'use client'

import type { LucideIcon } from 'lucide-react'
import type { StatusVariant } from 'ui/utils/status-indicator'
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/node-card'

interface PinnedNodeProps {
  selected?: boolean
  loading?: boolean
  accent: string
  icon: LucideIcon
  iconClassName?: string
  status?: StatusVariant
  title: string
  subtitle?: string
  extra?: React.ReactNode
  input?: React.ReactNode
  output?: React.ReactNode
  preview?: React.ReactNode
}

export function PinnedNode({ selected, loading, accent, icon, iconClassName, status, title, subtitle, extra, input, output, preview }: PinnedNodeProps) {
  return (
    <NodeCard selected={selected} loading={loading} accent={accent}>
      <NodeCardHeader icon={icon} iconClassName={iconClassName} status={status} title={title} subtitle={subtitle} extra={extra} />
      <NodeCardContent>
        <div className='flex justify-between gap-2'>
          {input && <div className='flex-1 min-w-0'>{input}</div>}
          {output && <div className='flex flex-col gap-0.5'>{output}</div>}
        </div>
        {preview}
      </NodeCardContent>
    </NodeCard>
  )
}

export function StatsList({ items }: { items: { icon: LucideIcon; value: string }[] }) {
  return (
    <div className='flex flex-col gap-0.5'>
      {items.map((item) => (
        <div key={item.value} className='flex items-center gap-1.5 text-[10px]'>
          <item.icon className='h-2.5 w-2.5 text-muted-foreground shrink-0' />
          <span className='text-muted-foreground truncate'>{item.value}</span>
        </div>
      ))}
    </div>
  )
}
