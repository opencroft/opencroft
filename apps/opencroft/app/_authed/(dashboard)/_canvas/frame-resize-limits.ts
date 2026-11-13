// How small a frame may be resized from each of its resize controls. An edge
// the control moves stops at its members' bounding box plus the padding a
// frame leaves (as `growToHold` grows a frame to), so the frame never gets
// smaller than its content. React Flow applies a control's minimum size as a
// clamp that keeps the opposite edge where it is, which is what lets the left
// and top edges stop by a size: with the right edge held, "the left edge
// stays left of a member" is "the width stays at least this".

import type { ControlPosition, ReactFlowState } from '@xyflow/react'

import {
  FRAME_PADDING,
  FRAME_TITLE_PADDING,
  MIN_FRAME_SIZE,
  type NodeSize,
} from '@/app/_authed/(extension-runtime)/_frames'
import { ceilToGrid, floorToGrid } from '@/app/_authed/(extension-runtime)/_grid'

/** A frame as drawn: its top-left corner and size, absolute. */
export interface FrameBox {
  x: number
  y: number
  width: number
  height: number
}

/** The bounding box of a frame's members as drawn, absolute: left, top, right and bottom edges. */
export interface MembersBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Frame `id` as drawn and the bounding box of its members as drawn, read
 * from React Flow's store; null while the frame is not in it.
 *
 * `parentLookup` says who the members are; where they are is read from
 * `nodeLookup`. React Flow keeps a member's entry in `parentLookup` as it was
 * before its absolute position was worked out, so the position there is its
 * position in the frame, or where it was drawn before the last change.
 */
export function frameAndMembers(
  state: Pick<ReactFlowState, 'nodeLookup' | 'parentLookup'>,
  id: string,
): { frame: FrameBox; members: MembersBox | null } | null {
  const node = state.nodeLookup.get(id)
  if (!node) {
    return null
  }
  const frame = {
    ...node.internals.positionAbsolute,
    width: node.measured.width ?? 0,
    height: node.measured.height ?? 0,
  }
  const boxes = [...(state.parentLookup.get(id)?.keys() ?? [])].flatMap((memberId) => {
    const member = state.nodeLookup.get(memberId)
    if (!member) {
      return []
    }
    const { x, y } = member.internals.positionAbsolute
    return [{ x, y, right: x + (member.measured.width ?? 0), bottom: y + (member.measured.height ?? 0) }]
  })
  if (boxes.length === 0) {
    return { frame, members: null }
  }
  return {
    frame,
    members: {
      minX: Math.min(...boxes.map((b) => b.x)),
      minY: Math.min(...boxes.map((b) => b.y)),
      maxX: Math.max(...boxes.map((b) => b.right)),
      maxY: Math.max(...boxes.map((b) => b.bottom)),
    },
  }
}

/**
 * The minimum size React Flow is given for the resize control at `control`
 * of `frame`, whose members' bounding box is `members` (null: no members).
 * An axis the control does not move gets the smallest frame size.
 */
export function resizeLimits(frame: FrameBox, members: MembersBox | null, control: ControlPosition): NodeSize {
  let width = MIN_FRAME_SIZE.width
  let height = MIN_FRAME_SIZE.height
  if (members) {
    if (control.includes('left')) {
      width = Math.max(width, frame.x + frame.width - (floorToGrid(members.minX) - FRAME_PADDING))
    } else if (control.includes('right')) {
      width = Math.max(width, ceilToGrid(members.maxX) + FRAME_PADDING - frame.x)
    }
    if (control.includes('top')) {
      height = Math.max(height, frame.y + frame.height - (floorToGrid(members.minY) - FRAME_TITLE_PADDING))
    } else if (control.includes('bottom')) {
      height = Math.max(height, ceilToGrid(members.maxY) + FRAME_PADDING - frame.y)
    }
  }
  // Whole numbers: a control re-registers its drag handler whenever a limit
  // changes, and float noise while the frame moves would change it each step.
  return { width: Math.round(width), height: Math.round(height) }
}
