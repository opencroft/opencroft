'use client'

import { Handle, Position } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import { Button } from 'ui/button'

export const HANDLE_EXECUTION = 'execution'
export const HANDLE_FILESYSTEM = 'filesystem'

interface ButtonPinProps {
  handleId: string
  icon: LucideIcon
  label: string
  side: 'left' | 'right'
  onClick?: () => void
}

export function ButtonPin({ handleId, icon: Icon, label, side, onClick }: ButtonPinProps) {
  const pos = side === 'right' ? Position.Right : Position.Left
  const type = side === 'right' ? 'source' : 'target'

  return (
    <Button
      variant='ghost'
      size='sm'
      className='nodrag nopan h-5 text-[10px] px-1.5 w-full justify-between'
      onClick={onClick}
    >
      {side === 'left' && <Handle type={type} position={pos} id={handleId} className='inline-handle' />}
      <Icon className='h-2.5 w-2.5 shrink-0' />
      <span className='flex-1 truncate'>{label}</span>
      {side === 'right' && <Handle type={type} position={pos} id={handleId} className='inline-handle' />}
    </Button>
  )
}
