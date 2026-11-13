import { useInternalNode, useStore } from '@xyflow/react'
import { cn } from 'cn'
import { AlertTriangle } from 'lucide-react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'

import { useIsDropTarget } from '@/app/_authed/(dashboard)/_canvas/drop-target-context'
import { FrameResizer } from '@/app/_authed/(dashboard)/_canvas/frame-resizer'
import { inspectorIntent } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { NODE_ERRORS_TAB } from '@/app/_authed/(dashboard)/_canvas/node-errors-tab'
import { useNodeErrors } from '@/app/_authed/(dashboard)/_canvas/use-node-errors'

/**
 * How wide a frame's border is on screen, in pixels, at every zoom. The canvas
 * scales what it draws, so a width fixed in canvas pixels thins out to a
 * hairline when zoomed out; the frame divides this by the zoom instead.
 */
export const FRAME_BORDER_PX = 2

/**
 * How much of the frame's colour its fill mixes in, in percent: a light tint,
 * and twice as much on the frame a drag would drop into.
 */
const TINT = 8
const DROP_TARGET_TINT = 16

/**
 * The body of a frame node (palette category `Organization`): a tinted,
 * resizable area with its icon and label in the top-left corner, and a border
 * of the same width on screen at any zoom, dashed, and solid in the frame's
 * full colour while selected. While nodes are dragged, the frame the drop
 * would put them into (the innermost one under the pointer, the one they are
 * in already included) is highlighted the same way, with a deeper tint (see
 * `DropTargetContext`). The size it is resized to is stored on the node's
 * `style`, where the placement rules read its area (see `_frame-tree.ts`);
 * the canvas snaps it to the grid when the resize ends (see `_grid.ts`). It
 * cannot be resized smaller than the nodes inside it: each edge stops at
 * their boxes plus the padding a frame grows by (see `FrameResizer`). `children`
 * goes under the label. A frame in error shows it as a node card does, with a
 * warning icon and its label in the destructive colour; the errors themselves
 * are read in its inspector, which pressing the warning icon opens.
 */
export function CanvasFrame({
  id,
  selected,
  color,
  icon: Icon,
  label,
  children,
}: {
  id: string
  selected?: boolean
  color: string
  icon: ComponentType<{ className?: string; style?: CSSProperties }>
  label: string
  children?: ReactNode
}) {
  const node = useInternalNode(id)
  const inError = useNodeErrors(node ? { id: node.id, type: node.type, data: node.data } : null).length > 0
  const labelColor = inError ? 'var(--destructive)' : color
  const zoom = useStore((state) => state.transform[2])
  const dropTarget = useIsDropTarget(id)
  const solid = selected || dropTarget
  return (
    <>
      <FrameResizer id={id} selected={selected} />
      <div
        className={cn('h-full w-full rounded-lg p-3', solid ? 'border-solid' : 'border-dashed')}
        style={{
          backgroundColor: `color-mix(in oklch, ${color} ${dropTarget ? DROP_TARGET_TINT : TINT}%, transparent)`,
          borderWidth: FRAME_BORDER_PX / zoom,
          borderColor: solid ? color : `color-mix(in oklch, ${color} 60%, transparent)`,
        }}
      >
        <div className='flex items-center gap-1.5'>
          {inError ? (
            <button
              type='button'
              aria-label='Show errors'
              className='nodrag nopan flex cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
              onClick={(event) => {
                event.stopPropagation()
                inspectorIntent.open(id, NODE_ERRORS_TAB)
              }}
            >
              <AlertTriangle className='h-3.5 w-3.5' style={{ color: labelColor }} />
            </button>
          ) : (
            <Icon className='h-3.5 w-3.5' style={{ color: labelColor }} />
          )}
          <span className='text-xs font-semibold' style={{ color: labelColor }}>
            {label}
          </span>
        </div>
        {children}
      </div>
    </>
  )
}
