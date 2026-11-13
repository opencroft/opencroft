import {
  type ControlPosition,
  NodeResizeControl,
  type ReactFlowState,
  ResizeControlVariant,
  useStore,
} from '@xyflow/react'
import type { CSSProperties } from 'react'

import { frameAndMembers, resizeLimits } from '@/app/_authed/(dashboard)/_canvas/frame-resize-limits'
import { useTouchMoveMode } from '@/app/_authed/(dashboard)/_canvas/touch-move-mode'
import { TouchResizeControls } from '@/app/_authed/(dashboard)/_canvas/touch-resize-controls'
import type { NodeSize } from '@/app/_authed/(extension-runtime)/_frames'

const LINE_STYLE: CSSProperties = { border: '8px solid transparent', zIndex: 1 }
const HANDLE_STYLE: CSSProperties = { background: 'transparent', border: 'none', width: 16, height: 16, zIndex: 1 }

/** The controls `NodeResizer` draws: the four edges, then the four corners. */
const RESIZE_CONTROLS: { position: ControlPosition; variant: ResizeControlVariant; style: CSSProperties }[] = [
  ...(['top', 'right', 'bottom', 'left'] as const).map((position) => ({
    position,
    variant: ResizeControlVariant.Line,
    style: LINE_STYLE,
  })),
  ...(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((position) => ({
    position,
    variant: ResizeControlVariant.Handle,
    style: HANDLE_STYLE,
  })),
]

/** The limits of a resize control at each position. */
type FrameLimits = Record<ControlPosition, NodeSize>

/** The limits of frame `id`'s resize controls in `state`, null while it isn't there. */
function frameLimits(state: ReactFlowState, id: string): FrameLimits | null {
  const drawn = frameAndMembers(state, id)
  return (
    drawn &&
    (Object.fromEntries(
      RESIZE_CONTROLS.map(({ position }) => [position, resizeLimits(drawn.frame, drawn.members, position)]),
    ) as FrameLimits)
  )
}

function sameLimits(a: FrameLimits | null, b: FrameLimits | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      RESIZE_CONTROLS.every(
        ({ position }) => a[position].width === b[position].width && a[position].height === b[position].height,
      ))
  )
}

/**
 * The resize controls of frame `id`, drawn while it is selected. They are
 * `NodeResizer`'s controls, each given the limits of the edges it moves (see
 * `resizeLimits`), so that the frame stays around its members. React Flow
 * clamps a resize to those limits; it keeps the members where they are drawn
 * while the left or top edge moves. React Flow applies a changed limit to a
 * resize in progress, so a control's limits must hold still while it is
 * dragged: they are read from the members, which stay where they are drawn,
 * and from the frame's edges that control does not move. Under the canvas's
 * touch rules (see `useTouchMoveMode`) they are `TouchResizeControls`, with
 * the same limits, while move mode is on, and absent while it is off.
 */
export function FrameResizer({ id, selected }: { id: string; selected?: boolean }) {
  const limits = useStore((state) => frameLimits(state, id), sameLimits)
  const touchMoveMode = useTouchMoveMode()
  if (!selected || !limits || touchMoveMode === false) {
    return null
  }
  if (touchMoveMode) {
    return <TouchResizeControls limits={(position) => limits[position]} />
  }
  return RESIZE_CONTROLS.map(({ position, variant, style }) => (
    <NodeResizeControl
      key={position}
      position={position}
      variant={variant}
      style={style}
      minWidth={limits[position].width}
      minHeight={limits[position].height}
    />
  ))
}
