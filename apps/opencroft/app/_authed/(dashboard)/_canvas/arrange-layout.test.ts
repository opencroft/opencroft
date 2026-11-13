import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ArrangeAction,
  type ArrangeLink,
  type ArrangeNode,
  arrangeSelected,
} from '@/app/_authed/(dashboard)/_canvas/arrange-layout'
import {
  COLUMN_GAP_STEPS,
  columnGapSteps,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { GRID_STEP } from '@/app/_authed/(extension-runtime)/_grid'

interface TestNode extends ArrangeNode {
  frame?: boolean
}

function arrange(
  nodes: readonly TestNode[],
  action: ArrangeAction,
  links: readonly ArrangeLink[] = [],
  gapSteps: number = COLUMN_GAP_STEPS.initial,
): TestNode[] {
  return arrangeSelected(nodes, action, { links, columnGapSteps: gapSteps })
}

// Three nodes of different sizes, none of them on the grid to begin with.
// Their box runs from (13, 7) to (260, 190).
const three: TestNode[] = [
  { id: 'a', selected: true, position: { x: 13, y: 7 }, measured: { width: 100, height: 40 } },
  { id: 'b', selected: true, position: { x: 200, y: 52 }, measured: { width: 60, height: 80 } },
  { id: 'c', selected: true, position: { x: 91, y: 160 }, measured: { width: 140, height: 30 } },
]

/** A selected node at (x, y), `width` by `height`. */
function box(id: string, x: number, y: number, width = 100, height = 50): TestNode {
  return { id, selected: true, position: { x, y }, measured: { width, height } }
}

function positions(nodes: readonly TestNode[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((n) => [n.id, n.position]))
}

function overlap(p: TestNode, q: TestNode): boolean {
  const [pw, ph, qw, qh] = [
    p.measured?.width ?? 0,
    p.measured?.height ?? 0,
    q.measured?.width ?? 0,
    q.measured?.height ?? 0,
  ]
  return (
    p.position.x < q.position.x + qw &&
    q.position.x < p.position.x + pw &&
    p.position.y < q.position.y + qh &&
    q.position.y < p.position.y + ph
  )
}

const ACTIONS: ArrangeAction[] = [
  'align-left',
  'align-centre-x',
  'align-right',
  'align-top',
  'align-centre-y',
  'align-bottom',
  'row',
  'column',
  'tidy',
]

test('every action leaves every moved node on the grid', () => {
  for (const action of ACTIONS) {
    for (const node of arrange(three, action)) {
      assert.equal(node.position.x % GRID_STEP, 0, `${action}: ${node.id}.x = ${node.position.x}`)
      assert.equal(node.position.y % GRID_STEP, 0, `${action}: ${node.id}.y = ${node.position.y}`)
    }
  }
})

test('align left edges puts every left edge on the snapped leftmost one', () => {
  assert.deepEqual(positions(arrange(three, 'align-left')), {
    a: { x: 10, y: 10 },
    b: { x: 10, y: 50 },
    c: { x: 10, y: 160 },
  })
})

test('align right edges puts every right edge on the snapped rightmost one', () => {
  const nodes = arrange(three, 'align-right')
  for (const n of nodes) {
    assert.equal(n.position.x + (n.measured?.width ?? 0), 260, n.id)
  }
})

test('align horizontal centres centres every node on the selection box centre, snapped', () => {
  // The box's centre is 136.5, which snaps to 140.
  const nodes = arrange(three, 'align-centre-x')
  for (const n of nodes) {
    assert.equal(n.position.x + (n.measured?.width ?? 0) / 2, 140, n.id)
  }
})

test('align top and bottom edges use the snapped topmost and bottommost edges', () => {
  const top = arrange(three, 'align-top')
  assert.deepEqual(
    top.map((n) => n.position.y),
    [10, 10, 10],
  )
  const bottom = arrange(three, 'align-bottom')
  for (const n of bottom) {
    assert.equal(n.position.y + (n.measured?.height ?? 0), 190, n.id)
  }
})

test('a centre that falls between grid lines rounds the way snapToGrid does', () => {
  // The vertical centre line 98.5 snaps to 100; c is 30 high, so its top at 85
  // falls half a step between lines and rounds to 90.
  assert.deepEqual(positions(arrange(three, 'align-centre-y')), {
    a: { x: 10, y: 80 },
    b: { x: 200, y: 60 },
    c: { x: 90, y: 90 },
  })
})

test('a row of nodes spread left to right keeps their left-to-right order, one grid step apart, on the top edge', () => {
  // p is lower than q but left of it, and no two overlap along x.
  const nodes = arrange([box('p', 0, 300, 100, 100), box('q', 300, 0, 100, 100)], 'row')
  assert.deepEqual(positions(nodes), {
    p: { x: 0, y: 0 },
    q: { x: 110, y: 0 },
  })
})

test('a column turned into a row reads top to bottom as left to right, whatever its drift', () => {
  // The column leans: C3 is the leftmost and C2 the rightmost.
  const column = [box('C1', 0, 400, 200, 160), box('C2', 30, 600, 200, 160), box('C3', -20, 800, 200, 160)]
  assert.deepEqual(positions(arrange(column, 'row')), {
    C1: { x: -20, y: 400 },
    C2: { x: 190, y: 400 },
    C3: { x: 400, y: 400 },
  })
})

test('a row turned into a column reads left to right as top to bottom, whatever its drift', () => {
  // The row rises: R3 is the highest and R1 the lowest.
  const row = [box('R1', 0, 40, 200, 160), box('R2', 300, 20, 200, 160), box('R3', 600, 0, 200, 160)]
  assert.deepEqual(positions(arrange(row, 'column')), {
    R1: { x: 0, y: 0 },
    R2: { x: 0, y: 170 },
    R3: { x: 0, y: 340 },
  })
})

test('nodes overlapping along the axis through one another count as side by side', () => {
  // a, c and b overlap along x one into the next, so the row takes them top to bottom.
  const nodes = arrange(three, 'row')
  assert.deepEqual(positions(nodes), {
    a: { x: 10, y: 10 },
    b: { x: 120, y: 10 },
    c: { x: 190, y: 10 },
  })
  const ordered = [...nodes].sort((p, q) => p.position.x - q.position.x)
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    assert.equal(ordered[i].position.x - (prev.position.x + (prev.measured?.width ?? 0)), GRID_STEP)
  }
})

test('a column keeps the nodes in their top-to-bottom order, one grid step apart, on the left edge', () => {
  const nodes = arrange(three, 'column')
  assert.deepEqual(positions(nodes), {
    a: { x: 10, y: 10 },
    b: { x: 10, y: 60 },
    c: { x: 10, y: 150 },
  })
})

test('tidy up puts linked nodes in columns along their links, the column gap apart', () => {
  // a -> b -> c, standing in the opposite order.
  const nodes = [box('c', 0, 0), box('a', 500, 0), box('b', 250, 300)]
  const links = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ]
  assert.deepEqual(positions(arrange(nodes, 'tidy', links, 2)), {
    c: { x: 240, y: 0 },
    a: { x: 0, y: 0 },
    b: { x: 120, y: 0 },
  })
  assert.deepEqual(positions(arrange(nodes, 'tidy', links, 6)), {
    c: { x: 320, y: 0 },
    a: { x: 0, y: 0 },
    b: { x: 160, y: 0 },
  })
})

test('tidy up keeps the current top-to-bottom order inside a column, one grid step apart', () => {
  // s feeds t1 and t2; t2 stands above t1.
  const nodes = [box('s', 0, 100), box('t1', 300, 300), box('t2', 300, 0)]
  const links = [
    { source: 's', target: 't1' },
    { source: 's', target: 't2' },
  ]
  assert.deepEqual(positions(arrange(nodes, 'tidy', links)), {
    s: { x: 0, y: 0 },
    t1: { x: 120, y: 60 },
    t2: { x: 120, y: 0 },
  })
})

test('tidy up places a node after every node linking into it, by the longest run of links', () => {
  // a -> b -> c and a -> c: c goes after b, not beside it.
  const nodes = [box('a', 0, 0), box('b', 0, 100), box('c', 0, 200)]
  const links = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'a', target: 'c' },
  ]
  assert.deepEqual(positions(arrange(nodes, 'tidy', links)), {
    a: { x: 0, y: 0 },
    b: { x: 120, y: 0 },
    c: { x: 240, y: 0 },
  })
})

test('tidy up cuts a loop so the node further left now comes first', () => {
  const loop = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
  ]
  assert.deepEqual(positions(arrange([box('a', 0, 0), box('b', 200, 0)], 'tidy', loop)), {
    a: { x: 0, y: 0 },
    b: { x: 120, y: 0 },
  })
  assert.deepEqual(positions(arrange([box('a', 200, 0), box('b', 0, 0)], 'tidy', loop)), {
    a: { x: 120, y: 0 },
    b: { x: 0, y: 0 },
  })
})

test('tidy up lays unlinked nodes out as a table of their current rows and columns', () => {
  // Two rows and two columns, each drifting a little.
  const nodes = [
    box('p', 0, 0, 200, 100),
    box('q', 220, 10, 100, 100),
    box('r', 5, 200, 100, 160),
    box('s', 230, 190, 150, 100),
  ]
  assert.deepEqual(positions(arrange(nodes, 'tidy')), {
    p: { x: 0, y: 0 },
    q: { x: 210, y: 0 },
    r: { x: 0, y: 110 },
    s: { x: 210, y: 110 },
  })
})

test('tidy up sets nodes that share a cell side by side in it', () => {
  // w spans both of u and v's columns, so the three make one column.
  const nodes = [box('u', 0, 0), box('v', 200, 0), box('w', 0, 100, 300, 50)]
  assert.deepEqual(positions(arrange(nodes, 'tidy')), {
    u: { x: 0, y: 0 },
    v: { x: 110, y: 0 },
    w: { x: 0, y: 60 },
  })
})

test('tidy up puts unlinked nodes one grid step below the linked ones', () => {
  const nodes = [box('a', 0, 0), box('b', 300, 0), box('l', 50, 200, 100, 80)]
  assert.deepEqual(positions(arrange(nodes, 'tidy', [{ source: 'a', target: 'b' }])), {
    a: { x: 0, y: 0 },
    b: { x: 120, y: 0 },
    l: { x: 0, y: 60 },
  })
})

test('tidy up counts only links between two selected nodes', () => {
  const idle: TestNode = { id: 'x', position: { x: 150, y: 500 }, measured: { width: 100, height: 50 } }
  const links = [
    { source: 'a', target: 'x' },
    { source: 'x', target: 'b' },
  ]
  assert.deepEqual(positions(arrange([box('a', 0, 0), box('b', 300, 0), idle], 'tidy', links)), {
    a: { x: 0, y: 0 },
    b: { x: 110, y: 0 },
    x: { x: 150, y: 500 },
  })
})

test('tidy up leaves no two nodes overlapping', () => {
  const nodes = [
    box('a', 13, 7, 140, 90),
    box('b', 60, 40, 200, 160),
    box('c', 90, 20, 75, 33),
    box('d', 400, 380, 210, 70),
    box('e', 410, 390, 90, 300),
    box('f', 0, 600, 333, 21),
  ]
  const links = [
    { source: 'a', target: 'b' },
    { source: 'c', target: 'b' },
  ]
  for (const gap of [COLUMN_GAP_STEPS.min, COLUMN_GAP_STEPS.max]) {
    const result = arrange(nodes, 'tidy', links, gap)
    for (const p of result) {
      for (const q of result) {
        assert.ok(p === q || !overlap(p, q), `gap ${gap}: ${p.id} overlaps ${q.id}`)
      }
    }
  }
})

test('the column gap is a whole number of grid steps within its bounds', () => {
  assert.equal(columnGapSteps(0), COLUMN_GAP_STEPS.min)
  assert.equal(columnGapSteps(99), COLUMN_GAP_STEPS.max)
  assert.equal(columnGapSteps(2.6), 3)
  assert.equal(columnGapSteps(Number.NaN), COLUMN_GAP_STEPS.initial)
  assert.equal(columnGapSteps('4'), COLUMN_GAP_STEPS.initial)
})

test('unselected nodes keep their place and their identity', () => {
  const idle: TestNode = { id: 'idle', position: { x: 3, y: 3 }, measured: { width: 10, height: 10 } }
  const nodes = arrange([...three, idle], 'row')
  assert.equal(
    nodes.find((n) => n.id === 'idle'),
    idle,
  )
})

test('with fewer than two nodes selected nothing moves', () => {
  const one = three.map((n) => ({ ...n, selected: n.id === 'a' }))
  assert.deepEqual(positions(arrange(one, 'align-left')), positions(one))
})

const frame: TestNode = {
  id: 'frame',
  frame: true,
  position: { x: 0, y: 0 },
  style: { width: 400, height: 300 },
  measured: { width: 400, height: 300 },
}

/** A selected node inside `frame`, at `x`, `y` relative to it. */
function member(id: string, x: number, y: number, width = 100, height = 40): TestNode {
  return { ...box(id, x, y, width, height), parentId: 'frame' }
}

test('nodes arranged inside a frame stay in it, stored relative to it', () => {
  const nodes: TestNode[] = [{ ...frame, position: { x: 100, y: 100 } }, member('p', 20, 20), member('q', 300, 200, 60)]
  assert.deepEqual(positions(arrange(nodes, 'row')), {
    frame: { x: 100, y: 100 },
    p: { x: 20, y: 20 },
    q: { x: 130, y: 20 },
  })
})

test('an action that moves a node over a frame it is not in is applied, and the node stays out of it', () => {
  const nodes: TestNode[] = [frame, box('p', 20, 20), box('r', 600, 20)]
  const result = arrange(nodes, 'align-left')
  assert.deepEqual(positions(result).r, { x: 20, y: 20 })
  assert.equal(result.find((n) => n.id === 'r')?.parentId, undefined)
})

test('an action that puts a node past its own frame keeps it in the frame', () => {
  const nodes: TestNode[] = [frame, member('p', 20, 20), box('r', 600, 20)]
  // The right edge is 700, so p's corner lands at 600, outside the frame.
  const p = arrange(nodes, 'align-right').find((n) => n.id === 'p')
  assert.equal(p?.parentId, 'frame')
  assert.equal(p?.position.x, 600 - (frame.position.x ?? 0))
})

test('a moved frame takes its members along, their stored positions unchanged', () => {
  const nodes: TestNode[] = [
    { ...frame, selected: true },
    { id: 'held', parentId: 'frame', position: { x: 40, y: 40 }, measured: { width: 50, height: 50 } },
    box('s', 500, 400, 50, 50),
  ]
  // The right edge is 550: the frame moves 150 right.
  assert.deepEqual(positions(arrange(nodes, 'align-right')), {
    frame: { x: 150, y: 0 },
    held: { x: 40, y: 40 },
    s: { x: 500, y: 400 },
  })
})

test('a selected node in a selected frame moves with the frame, not on its own', () => {
  const nodes: TestNode[] = [{ ...frame, selected: true }, member('held', 20, 20), box('s', 500, 400, 50, 50)]
  assert.deepEqual(positions(arrange(nodes, 'align-right')), {
    frame: { x: 150, y: 0 },
    held: { x: 20, y: 20 },
    s: { x: 500, y: 400 },
  })
})

test('a member of a nested frame is placed by where it is drawn', () => {
  const nodes: TestNode[] = [
    { ...frame, position: { x: 100, y: 100 } },
    { id: 'inner', frame: true, parentId: 'frame', position: { x: 50, y: 50 }, style: { width: 300, height: 200 } },
    { ...box('kid', 100, 10, 40, 40), parentId: 'inner' },
    { ...box('m', 80, 150, 40, 40), parentId: 'inner' },
  ]
  // Drawn at x 250 and 230: aligned on 230, which is 80 inside the inner frame.
  const result = arrange(nodes, 'align-left')
  assert.deepEqual(positions(result).kid, { x: 80, y: 10 })
  assert.equal(result.find((n) => n.id === 'kid')?.parentId, 'inner')
})

test('a selected child of a selected parent moves with its parent', () => {
  const nodes: TestNode[] = [
    box('parent', 100, 100, 200, 200),
    { id: 'kid', parentId: 'parent', selected: true, position: { x: 10, y: 10 }, measured: { width: 40, height: 40 } },
    box('m', 50, 400, 40, 40),
  ]
  assert.deepEqual(positions(arrange(nodes, 'align-left')), {
    parent: { x: 50, y: 100 },
    kid: { x: 10, y: 10 },
    m: { x: 50, y: 400 },
  })
})
