import { useReactFlow, useStore, useUpdateNodeInternals } from '@xyflow/react'
import { X } from 'lucide-react'
import { type ComponentType, type ReactNode, useCallback, useEffect, useState } from 'react'
import { Button } from 'ui/button'

import { NodeCard } from '@/app/_authed/(dashboard)/_canvas/node-card'
import { useNodeAccent } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { NodeResizer } from '@/app/_authed/(dashboard)/_canvas/node-resizer'
import { NodeDragArea } from '@/app/_authed/(dashboard)/_canvas/touch-move-mode'
import type { NodeSize } from '@/app/_authed/(extension-runtime)/_frames'
import { type AxisSize, ownSize } from '@/app/_authed/(extension-runtime)/_grid'

const OPEN_ANIMATION_MS = 250
const CLOSE_ANIMATION_MS = 200

export interface WindowShellProps {
  id: string
  selected?: boolean
  loading?: boolean
  icon: ComponentType<{ className?: string }>
  iconClassName?: string
  title: string
  bodyClassName?: string
  /** The input pin in the title bar, on the window's left edge. */
  input?: ReactNode
  /**
   * Input pins of their own, each with its label, in a column under the title bar, on the window's
   * left edge: for a window with more than one input.
   */
  inputs?: ReactNode
  /** Controls in the title bar, before its close. They take clicks, so each carries `nodrag nopan`. */
  actions?: ReactNode
  children: ReactNode
  minWidth?: number
  minHeight?: number
  /**
   * The size the window is drawn at on an axis its node holds no size of its own: a node created
   * with none, such as one from a palette category other than Windows or one an agent created
   * without a size. Resizing gives the node a size, which wins from then on. Unset, such a node is
   * as big as its content.
   */
  defaultSize?: NodeSize
  /**
   * Shows the title bar's close, which removes the node. On by default; off for a window whose
   * node holds content of its own, where one stray click would delete it. Such a node is still
   * deleted the way any node is.
   */
  closable?: boolean
}

/** What `defaultSize` gives a node holding `own`: the axes it holds no size on. */
export function fallbackSize(own: AxisSize, defaultSize: NodeSize | undefined): AxisSize {
  if (!defaultSize) {
    return {}
  }
  return {
    ...(own.width === undefined ? { width: defaultSize.width } : {}),
    ...(own.height === undefined ? { height: defaultSize.height } : {}),
  }
}

/**
 * A node drawn as a window: a resizable card with a title bar to drag it by and a body that fills
 * the rest. The canvas's resizer and touch rules apply to it as to any node.
 */
export function WindowShell({
  id,
  selected,
  loading,
  icon: Icon,
  iconClassName,
  title,
  bodyClassName,
  input,
  inputs,
  actions,
  children,
  minWidth = 300,
  minHeight = 200,
  defaultSize,
  closable = true,
}: WindowShellProps) {
  const accent = useNodeAccent()
  const { setNodes } = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const [closing, setClosing] = useState(false)
  // Two selections of plain numbers, so a store change elsewhere doesn't redraw the window.
  const ownWidth = useStore((state) => {
    const node = state.nodeLookup.get(id)
    return node ? ownSize(node).width : undefined
  })
  const ownHeight = useStore((state) => {
    const node = state.nodeLookup.get(id)
    return node ? ownSize(node).height : undefined
  })
  const fallback = fallbackSize({ width: ownWidth, height: ownHeight }, defaultSize)

  useEffect(() => {
    const t = setTimeout(() => updateNodeInternals(id), OPEN_ANIMATION_MS)
    return () => clearTimeout(t)
  }, [id, updateNodeInternals])

  const close = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setNodes((nds) => nds.filter((n) => n.id !== id))
    }, CLOSE_ANIMATION_MS)
  }, [id, setNodes])

  return (
    <>
      <NodeResizer
        isVisible
        minWidth={minWidth}
        minHeight={minHeight}
        lineStyle={{ border: '8px solid transparent', zIndex: 1 }}
        handleStyle={{ background: 'transparent', border: 'none', width: 16, height: 16, zIndex: 1 }}
      />
      <div className={`h-full w-full ${closing ? 'window-node-close' : 'window-node-open'}`} style={fallback}>
        <NodeCard selected={selected} loading={loading} accent={accent} className='h-full w-full min-w-0 flex flex-col'>
          {/* At least 44px tall on a coarse pointer, the minimum touch target, so a finger can drag the window by it.
              Stacked above the body, which its drag area reaches into. */}
          <div className='relative isolate z-10 flex items-center gap-2 px-4 py-2 pointer-coarse:min-h-11'>
            <NodeDragArea />
            {input}
            <Icon className={`h-4 w-4 shrink-0 ${iconClassName ?? ''}`} />
            <span className='text-sm font-medium truncate flex-1'>{title}</span>
            {actions}
            {closable ? (
              <Button
                variant='ghost'
                size='icon'
                className='nodrag nopan h-4 w-4 shrink-0'
                onClick={close}
                aria-label='Close'
              >
                <X className='h-3 w-3' />
              </Button>
            ) : null}
          </div>
          {inputs ? <div className='flex flex-col gap-1 px-4 pb-2'>{inputs}</div> : null}
          {/* The body does not move the node, so it drops the grab cursor React Flow gives a draggable
              node: the browser's own cursor shows the text cursor over text and the hand over a link. */}
          <div
            className={`flex-1 nodrag nopan cursor-auto overflow-hidden rounded-b-md mx-px mb-px relative ${bodyClassName ?? 'bg-card'}`}
          >
            <div className='absolute inset-2'>{children}</div>
          </div>
        </NodeCard>
      </div>
    </>
  )
}
