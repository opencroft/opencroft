'use client'

import type { Node, NodeProps } from '@xyflow/react'
import { memo } from 'react'

interface BubbleHintNodeData {
  hintId: string
  message: string
  onDismiss?: (hintId: string) => void
  [key: string]: unknown
}

export type BubbleHintNodeType = Node<BubbleHintNodeData, 'bubble-hint'>

export const BubbleHintNode = memo(function BubbleHintNode({ data }: NodeProps) {
  const { hintId, message, onDismiss } = data as BubbleHintNodeData

  return (
    <div className='pointer-events-auto nodrag nopan' style={{ transform: 'translate(-50%, -100%)' }}>
      <div className='relative rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg whitespace-nowrap'>
        <p className='pr-5 leading-snug'>{message}</p>
        {onDismiss && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(hintId)
            }}
            className='absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground opacity-60 transition-opacity hover:opacity-100'
            aria-label='Dismiss hint'
          >
            <svg
              width='12'
              height='12'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <line x1='18' y1='6' x2='6' y2='18' />
              <line x1='6' y1='6' x2='18' y2='18' />
            </svg>
          </button>
        )}
        <div className='absolute -bottom-[6px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-border bg-popover' />
      </div>
    </div>
  )
}) as React.FC<NodeProps>
