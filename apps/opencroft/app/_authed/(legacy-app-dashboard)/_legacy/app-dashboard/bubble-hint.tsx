'use client'

import { memo } from 'react'

export interface BubbleHintProps {
  hintId: string
  nodeId: string
  message: string
  /** Screen X coordinate (px from viewport left). */
  screenX: number
  /** Screen Y coordinate (px from viewport top). */
  screenY: number
  onClose: (hintId: string) => void
}

/**
 * A floating hint bubble rendered as an overlay on the ReactFlow canvas.
 * Uses screen coordinates (computed via flowToScreenPosition) for accurate
 * positioning regardless of pan/zoom.
 */
export const BubbleHint = memo(function BubbleHint({ hintId, message, screenX, screenY, onClose }: BubbleHintProps) {
  return (
    <div
      className='pointer-events-auto absolute z-[100] max-w-[280px]'
      style={{
        left: screenX,
        top: screenY,
        transform: 'translate(-50%, calc(-100% - 12px))',
      }}
    >
      {/* Bubble body */}
      <div className='relative rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg'>
        <p className='pr-5 leading-snug'>{message}</p>
        {/* Close button */}
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onClose(hintId)
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
        {/* Arrow pointing down to the node */}
        <div className='absolute -bottom-[6px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-border bg-popover' />
      </div>
    </div>
  )
})
