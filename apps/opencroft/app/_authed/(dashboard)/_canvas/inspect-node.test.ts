// A request for a node's inspector tab shows that node: it alone is selected,
// whatever was selected before, and the view moves only when the node is out
// of sight.

import assert from 'node:assert/strict'
import test from 'node:test'

import { revealViewport, selectOnly } from '@/app/_authed/(dashboard)/_canvas/inspect-node'

test('the node asked for becomes the only selection, replacing a multi-selection', () => {
  const nodes = [
    { id: 'a', selected: true },
    { id: 'b', selected: true },
    { id: 'c', selected: false },
  ]
  assert.deepEqual(
    selectOnly(nodes, 'c').map((n) => [n.id, n.selected]),
    [
      ['a', false],
      ['b', false],
      ['c', true],
    ],
  )
})

test('selecting keeps the rest of each node', () => {
  const [node] = selectOnly([{ id: 'a', type: 'app', data: { name: 'Web' } }], 'a')
  assert.deepEqual(node, { id: 'a', type: 'app', data: { name: 'Web' }, selected: true })
})

const box = { x: 100, y: 50, width: 200, height: 100 }
const pane = (width: number, height: number) => ({ left: 0, top: 0, width, height })

test('a node seen whole leaves the view where it is', () => {
  assert.equal(revealViewport(box, pane(800, 600), [0, 0, 1]), null)
  // Touching the pane's edges still counts as seen.
  assert.equal(revealViewport({ x: 0, y: 0, width: 800, height: 600 }, pane(800, 600), [0, 0, 1]), null)
})

test('a node out of sight is centred at the same zoom', () => {
  // Scrolled far right: the node is off the left edge.
  assert.deepEqual(revealViewport(box, pane(800, 600), [-1000, 0, 1]), { x: 200, y: 200, zoom: 1 })
  // Zoomed in: the centre is taken through the zoom, which is kept.
  assert.deepEqual(revealViewport(box, pane(800, 600), [-500, -500, 2]), { x: 0, y: 100, zoom: 2 })
})

test('a node cut by the pane edge counts as out of sight', () => {
  // Its right side ends past a pane narrowed to 250 by the inspector.
  assert.deepEqual(revealViewport(box, pane(250, 600), [0, 0, 1]), { x: -75, y: 200, zoom: 1 })
})

test('a node under a sidebar lying over the canvas is out of sight, and is centred in what is left', () => {
  // A 300px sidebar covers the canvas's left: the node at 100..300 is under it.
  const visible = { left: 300, top: 0, width: 500, height: 600 }
  assert.deepEqual(revealViewport(box, visible, [0, 0, 1]), { x: 350, y: 200, zoom: 1 })
  // Moved right of the sidebar, it is seen.
  assert.equal(revealViewport(box, visible, [300, 0, 1]), null)
})
