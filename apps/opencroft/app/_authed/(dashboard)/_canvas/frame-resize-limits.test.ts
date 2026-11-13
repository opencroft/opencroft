import assert from 'node:assert/strict'
import test from 'node:test'

import { adoptUserNodes, type InternalNodeBase, type NodeBase, type ParentLookup } from '@xyflow/system'

import { frameAndMembers, resizeLimits } from '@/app/_authed/(dashboard)/_canvas/frame-resize-limits'

// A frame at the origin, 900 by 600, its members' boxes spanning (40, 60) to (500, 100).
const frame = { x: 0, y: 0, width: 900, height: 600 }
const members = { minX: 40, minY: 60, maxX: 500, maxY: 100 }

test('the right and bottom edges stop one grid step past the members’ far edges', () => {
  assert.deepEqual(resizeLimits(frame, members, 'bottom-right'), { width: 510, height: 160 })
  // 110 is below the smallest frame height, which holds.
  assert.deepEqual(resizeLimits(frame, members, 'right'), { width: 510, height: 160 })
})

test('the left edge stops one grid step before the members, the top edge four, for the title', () => {
  // The right edge stays at 900, so a left edge at 30 is a width of 870; the
  // bottom edge stays at 600, so a top edge at 20 is a height of 580.
  assert.deepEqual(resizeLimits(frame, members, 'top-left'), { width: 870, height: 580 })
  assert.deepEqual(resizeLimits(frame, members, 'left'), { width: 870, height: 160 })
  assert.deepEqual(resizeLimits(frame, members, 'top'), { width: 200, height: 580 })
})

test('a mixed corner takes each axis from the edge it moves', () => {
  assert.deepEqual(resizeLimits(frame, members, 'top-right'), { width: 510, height: 580 })
  assert.deepEqual(resizeLimits(frame, members, 'bottom-left'), { width: 870, height: 160 })
})

test('the limit holds still while the left edge moves', () => {
  // Mid-resize: the left edge has come in 100, the right edge has not moved.
  const moved = { x: 100, y: 0, width: 800, height: 600 }
  assert.deepEqual(resizeLimits(moved, members, 'left'), resizeLimits(frame, members, 'left'))
})

test('a member edge off the grid stops the left edge on the grid line before it', () => {
  const shifted = { x: -100, y: -100, width: 610, height: 260 }
  const offGrid = { minX: 41, minY: 63, maxX: 501, maxY: 103 }
  // Left edge stops at 40 - 10 = 30, the right edge being at 510: width 480.
  // The top edge would stop at 60 - 40 = 20, a height of 140, below the smallest frame height.
  assert.deepEqual(resizeLimits(shifted, offGrid, 'top-left'), { width: 480, height: 160 })
})

test('a frame with no members stops at the smallest frame size', () => {
  assert.deepEqual(resizeLimits(frame, null, 'top-left'), { width: 200, height: 160 })
})

/** React Flow's store for `nodes`, built by React Flow's own adoption of them. */
function adopted(nodes: NodeBase[]) {
  const nodeLookup = new Map<string, InternalNodeBase>()
  const parentLookup: ParentLookup<InternalNodeBase> = new Map()
  adoptUserNodes(nodes, nodeLookup, parentLookup)
  return { nodeLookup, parentLookup }
}

// The frame at (-130, -130), 1030 by 730: its right and bottom edges are at
// 900 and 600. Its members are drawn at (40, 60), 200 by 60, and (500, 100),
// 300 by 80; their positions in the frame are 130 further on.
const away: NodeBase[] = [
  {
    id: 'frame',
    position: { x: -130, y: -130 },
    measured: { width: 1030, height: 730 },
    data: {},
  },
  { id: 'a', parentId: 'frame', position: { x: 170, y: 190 }, measured: { width: 200, height: 60 }, data: {} },
  { id: 'b', parentId: 'frame', position: { x: 630, y: 230 }, measured: { width: 300, height: 80 }, data: {} },
]

test('a frame away from the origin reads its members’ boxes where they are drawn', () => {
  assert.deepEqual(frameAndMembers(adopted(away), 'frame'), {
    frame: { x: -130, y: -130, width: 1030, height: 730 },
    members: { minX: 40, minY: 60, maxX: 800, maxY: 180 },
  })
})

test('a frame away from the origin stops each edge at the drawn members plus the padding', () => {
  const drawn = frameAndMembers(adopted(away), 'frame')
  assert.ok(drawn)
  // Left edge at 30 with the right edge at 900; top edge at 20 with the bottom edge at 600.
  assert.deepEqual(resizeLimits(drawn.frame, drawn.members, 'top-left'), { width: 870, height: 580 })
  // Right edge at 810 and bottom edge at 190, with the left and top edges at -130.
  assert.deepEqual(resizeLimits(drawn.frame, drawn.members, 'bottom-right'), { width: 940, height: 320 })
})

test('a frame that is not in the store has no limits to read', () => {
  assert.equal(frameAndMembers(adopted(away), 'elsewhere'), null)
})
