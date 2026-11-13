import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArrangeLink } from '@/app/_authed/(dashboard)/_canvas/arrange-layout'
import { type AutolayoutNode, autolayoutSections } from '@/app/_authed/(dashboard)/_canvas/section-autolayout'
import { SECTION_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { ceilToGrid, GRID_STEP } from '@/app/_authed/(extension-runtime)/_grid'

// Positions of a section's members are relative to the section's corner, as the canvas stores them.

function section(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  data: Record<string, unknown> = {},
  parentId?: string,
): AutolayoutNode {
  return {
    id,
    type: SECTION_TYPE,
    position: { x, y },
    style: { width, height },
    data: { label: id, color: 'red', autolayout: true, ...data },
    ...(parentId ? { parentId } : {}),
  }
}

/** A card inside `parentId` (the section S unless said), at `x`, `y` relative to it. */
function card(
  id: string,
  x: number,
  y: number,
  width?: number,
  height?: number,
  parentId: string | null = 'S',
): AutolayoutNode {
  return {
    id,
    type: 'acme.kit.log',
    position: { x, y },
    ...(parentId ? { parentId } : {}),
    ...(width === undefined || height === undefined ? {} : { measured: { width, height } }),
  }
}

const byId = (nodes: AutolayoutNode[], id: string) => nodes.find((n) => n.id === id) as AutolayoutNode
const at = (nodes: AutolayoutNode[], id: string) => byId(nodes, id).position
const sizeOf = (nodes: AutolayoutNode[], id: string) => byId(nodes, id).style

test('lays out the section members from inside its corner and fits the section around them', () => {
  const nodes = [section('S', 0, 0, 400, 300), card('A', 100, 100, 200, 60), card('B', 50, 200, 150, 80)]
  const next = autolayoutSections(nodes, [])
  // One column of two rows: A above B, one grid step apart, from one step in
  // on the left and four down from the top.
  assert.deepEqual(at(next, 'A'), { x: GRID_STEP, y: 4 * GRID_STEP })
  assert.deepEqual(at(next, 'B'), { x: GRID_STEP, y: 4 * GRID_STEP + 60 + GRID_STEP })
  // One step past the widest node's right edge and the lowest node's bottom.
  assert.deepEqual(at(next, 'S'), { x: 0, y: 0 })
  assert.deepEqual(sizeOf(next, 'S'), { width: 10 + 200 + 10, height: 110 + 80 + 10 })
})

test('lays members out relative to a section away from the origin, leaving the section where it is', () => {
  const nodes = [section('S', 500, 300, 400, 300), card('A', 100, 100, 200, 60)]
  const next = autolayoutSections(nodes, [])
  assert.deepEqual(at(next, 'S'), { x: 500, y: 300 })
  assert.deepEqual(at(next, 'A'), { x: 10, y: 40 })
})

test('a laid-out section is left as it is: the same nodes back', () => {
  const nodes = [section('S', 0, 0, 400, 300), card('A', 100, 100, 200, 60), card('B', 50, 200, 150, 80)]
  const once = autolayoutSections(nodes, [])
  assert.notEqual(once, nodes)
  assert.equal(autolayoutSections(once, []), once)
})

test('rounds a node size between grid lines up, so every edge is on the grid', () => {
  const nodes = [section('S', 0, 0, 400, 300), card('A', 20, 50, 201.5, 63)]
  const next = autolayoutSections(nodes, [])
  assert.deepEqual(sizeOf(next, 'S'), { width: 10 + 210 + 10, height: 40 + 70 + 10 })
})

test('lays linked nodes out in columns the section column gap apart', () => {
  const nodes = [
    section('S', 0, 0, 800, 400, { columnGapSteps: 3 }),
    card('B', 50, 50, 150, 80),
    card('A', 400, 100, 200, 60),
  ]
  const links: ArrangeLink[] = [{ source: 'A', target: 'B' }]
  const next = autolayoutSections(nodes, links)
  assert.deepEqual(at(next, 'A'), { x: 10, y: 40 })
  assert.deepEqual(at(next, 'B'), { x: 10 + 200 + 3 * GRID_STEP, y: 40 })
  assert.deepEqual(sizeOf(next, 'S'), { width: 240 + 150 + 10, height: 40 + 80 + 10 })
})

test('takes the initial column gap when the section has none stored', () => {
  const nodes = [section('S', 0, 0, 800, 400), card('A', 50, 50, 100, 50), card('B', 400, 50, 100, 50)]
  const next = autolayoutSections(nodes, [{ source: 'A', target: 'B' }])
  assert.equal(at(next, 'B').x, 10 + 100 + 2 * GRID_STEP)
})

test('leaves a node that is not a member where it is, even one under the section', () => {
  const outside = card('Out', 500, 100, 100, 50, null)
  const under = card('Under', 150, 150, 100, 50, null)
  const nodes = [section('S', 0, 0, 400, 300), card('A', 100, 100, 200, 60), outside, under]
  const next = autolayoutSections(nodes, [])
  assert.equal(byId(next, 'Out'), outside)
  assert.equal(byId(next, 'Under'), under)
})

test('a section that grows over an outside node leaves it outside', () => {
  // The node sits just below the section; a member growing tall grows the section over it.
  const below = card('Below', 20, 200, 100, 50, null)
  const nodes = [section('S', 0, 0, 220, 110), card('A', 10, 40, 200, 60), below]
  const grown = autolayoutSections(
    nodes.map((n) => (n.id === 'A' ? { ...n, measured: { width: 200, height: 400 } } : n)),
    [],
  )
  assert.deepEqual(sizeOf(grown, 'S'), { width: 220, height: 40 + 400 + 10 })
  assert.equal(byId(grown, 'Below'), below)
  assert.equal(autolayoutSections(grown, []), grown)
})

test('waits while a member has no size yet', () => {
  const nodes = [section('S', 0, 0, 400, 300), card('A', 100, 100, 200, 60), card('B', 50, 200)]
  assert.equal(autolayoutSections(nodes, []), nodes)
})

test('takes a node size of its own over a measured one', () => {
  const sized = { ...card('A', 100, 100, 999, 999), style: { width: 200, height: 60 } }
  const next = autolayoutSections([section('S', 0, 0, 400, 300), sized], [])
  assert.deepEqual(sizeOf(next, 'S'), { width: 220, height: 110 })
})

test('changes nothing with Autolayout off, or in an empty section', () => {
  const off = [section('S', 0, 0, 400, 300, { autolayout: false }), card('A', 100, 100, 200, 60)]
  assert.equal(autolayoutSections(off, []), off)
  const empty = [section('S', 0, 0, 400, 300)]
  assert.equal(autolayoutSections(empty, []), empty)
})

test('lays a frame inside out as one box; its own members keep their place in it', () => {
  const inner = card('C', 20, 50, 50, 30, 'F')
  const nodes = [section('S', 0, 0, 500, 400), section('F', 100, 100, 200, 100, { autolayout: false }, 'S'), inner]
  const next = autolayoutSections(nodes, [])
  assert.deepEqual(at(next, 'F'), { x: 10, y: 40 })
  assert.equal(byId(next, 'C'), inner)
  assert.deepEqual(sizeOf(next, 'S'), { width: 220, height: 150 })
})

test('lays out an autolayout section inside another first, and the outer one at its fitted size', () => {
  const nodes = [
    section('Outer', 0, 0, 600, 600),
    section('Inner', 100, 100, 300, 300, {}, 'Outer'),
    card('D', 50, 100, 100, 50, 'Inner'),
  ]
  const next = autolayoutSections(nodes, [])
  assert.deepEqual(sizeOf(next, 'Inner'), { width: 120, height: 100 })
  assert.deepEqual(at(next, 'Inner'), { x: 10, y: 40 })
  assert.deepEqual(at(next, 'D'), { x: 10, y: 40 })
  assert.deepEqual(sizeOf(next, 'Outer'), { width: 140, height: 150 })
  assert.equal(autolayoutSections(next, []), next)
})

test('a fitted section that reaches past the frame it sits in grows that frame, both as the canvas measured them', () => {
  const drawn = (n: AutolayoutNode): AutolayoutNode => ({
    ...n,
    measured: n.style as { width: number; height: number },
  })
  const nodes = [
    drawn(section('F', 0, 0, 200, 150, { autolayout: false })),
    drawn(section('S', 10, 40, 100, 100, {}, 'F')),
    card('A', 10, 40, 300, 60),
  ]
  const next = autolayoutSections(nodes, [])
  assert.deepEqual(sizeOf(next, 'S'), { width: 320, height: 110 })
  // S reaches to (10 + 320, 40 + 110): plus the padding.
  assert.deepEqual(sizeOf(next, 'F'), { width: 340, height: 160 })
})

test('moves a section off the grid onto it', () => {
  const nodes = [section('S', 3, 7, 400, 300), card('A', 97, 93, 200, 60)]
  const next = autolayoutSections(nodes, [])
  assert.deepEqual(at(next, 'S'), { x: 0, y: 10 })
  assert.deepEqual(at(next, 'A'), { x: 10, y: 40 })
})

test('leaves a comment overlay alone', () => {
  const comment = { ...card('note', 100, 250, 100, 40, null), type: 'comment' }
  const nodes = [section('S', 0, 0, 400, 300), card('A', 100, 100, 200, 60), comment]
  const next = autolayoutSections(nodes, [])
  assert.equal(byId(next, 'note'), comment)
})

test('a child of a member goes with it and is not laid out on its own', () => {
  const child = card('kid', 10, 10, 20, 20, 'A')
  const nodes = [section('S', 0, 0, 400, 300), card('A', 100, 100, 200, 60), child]
  const next = autolayoutSections(nodes, [])
  assert.equal(byId(next, 'kid'), child)
})

/** `nodes` with node `id` measured at a new size, as the canvas reports a card that grew or shrank. */
function resized(nodes: AutolayoutNode[], id: string, width: number, height: number): AutolayoutNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, measured: { width, height } } : n))
}

test('a node that shrinks and grows back returns the layout to where it was', () => {
  const links: ArrangeLink[] = [{ source: 'P', target: 'L1' }]
  const start = [
    section('S', 0, 0, 1200, 800),
    card('P', 700, 500, 440, 60),
    card('L1', 100, 100, 200, 60),
    card('L2', 150, 550, 200, 60),
    card('App', 600, 80, 320, 130),
  ]
  const laidOut = autolayoutSections(start, links)
  assert.deepEqual(at(laidOut, 'App'), { x: 220, y: 110 })
  assert.deepEqual(at(laidOut, 'L2'), { x: 10, y: 250 })

  const shrunk = autolayoutSections(resized(laidOut, 'App', 320, 110), links)
  assert.deepEqual(at(shrunk, 'L2'), { x: 10, y: 230 })

  // The card grows back past the row below it, one measurement at a time.
  const growing = autolayoutSections(resized(shrunk, 'App', 320, 124), links)
  const grown = autolayoutSections(resized(growing, 'App', 320, 130), links)
  for (const id of ['P', 'L1', 'L2', 'App']) {
    assert.deepEqual(at(grown, id), at(laidOut, id), id)
  }
  assert.deepEqual(sizeOf(grown, 'S'), sizeOf(laidOut, 'S'))
})

test('a node grown while nobody laid the section out keeps its row when the next pass catches up', () => {
  const laidOut = autolayoutSections(
    [section('S', 0, 0, 800, 800), card('A', 300, 50, 200, 60), card('B', 50, 300, 200, 60)],
    [],
  )
  assert.deepEqual(at(laidOut, 'A'), { x: 220, y: 40 })
  assert.deepEqual(at(laidOut, 'B'), { x: 10, y: 110 })
  // A grows past B's top before any pass runs again: B stays in the row below.
  const next = autolayoutSections(resized(laidOut, 'A', 200, 90), [])
  assert.deepEqual(at(next, 'A'), { x: 220, y: 40 })
  assert.deepEqual(at(next, 'B'), { x: 10, y: 140 })
})

test('records a laid-out section that holds no record yet, moving nothing', () => {
  const laidOut = autolayoutSections(
    [section('S', 0, 0, 800, 800), card('A', 300, 50, 200, 60), card('B', 50, 300, 200, 60)],
    [],
  )
  const unrecorded = laidOut.map((n) =>
    n.id === 'S' ? { ...n, data: { ...(n.data as object), laidOut: undefined } } : n,
  )
  const next = autolayoutSections(unrecorded, [])
  assert.notEqual(next, unrecorded)
  assert.deepEqual(at(next, 'A'), at(laidOut, 'A'))
  assert.deepEqual(at(next, 'B'), at(laidOut, 'B'))
  // Recorded, a card that grows past the row below keeps its order.
  const grown = autolayoutSections(resized(next, 'A', 200, 90), [])
  assert.deepEqual(at(grown, 'B'), { x: 10, y: 140 })
})

test('the record holds when the section is moved: a laid-out section moved changes nothing else', () => {
  const laidOut = autolayoutSections(
    [section('S', 0, 0, 800, 800), card('A', 300, 50, 200, 60), card('B', 50, 300, 200, 60)],
    [],
  )
  const moved = laidOut.map((n) => (n.id === 'S' ? { ...n, position: { x: 400, y: 200 } } : n))
  assert.equal(autolayoutSections(moved, []), moved)
})

test('a node dropped inside the section is laid out where its drop reads', () => {
  const laidOut = autolayoutSections(
    [
      section('S', 0, 0, 800, 800),
      card('A', 50, 50, 200, 60),
      card('B', 300, 50, 200, 60),
      card('C', 50, 300, 200, 60),
    ],
    [],
  )
  assert.deepEqual(at(laidOut, 'C'), { x: 10, y: 110 })
  assert.deepEqual(sizeOf(laidOut, 'S'), { width: 430, height: 180 })
  // Dropped over the top row, right of A: it joins that row after B.
  const dropped = laidOut.map((n) => (n.id === 'C' ? { ...n, position: { x: 240, y: 60 } } : n))
  const next = autolayoutSections(dropped, [])
  assert.deepEqual(at(next, 'A'), { x: 10, y: 40 })
  assert.deepEqual(at(next, 'B'), { x: 220, y: 40 })
  assert.deepEqual(at(next, 'C'), { x: 430, y: 40 })
  assert.deepEqual(sizeOf(next, 'S'), { width: 640, height: 110 })
})

// A small seeded generator, so a failure names the case that broke.
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
}

/**
 * A section away from the canvas origin, holding 1 to 9 cards of random sizes,
 * scattered, with random links among them.
 */
function scattered(next: () => number): { nodes: AutolayoutNode[]; cards: AutolayoutNode[]; links: ArrangeLink[] } {
  const count = 1 + Math.floor(next() * 9)
  const cards = Array.from({ length: count }, (_, i) =>
    card(`n${i}`, Math.floor(next() * 1400), 50 + Math.floor(next() * 1400), 40 + next() * 300, 30 + next() * 200),
  )
  const links: ArrangeLink[] = []
  for (let i = 0; i < count; i++) {
    if (next() < 0.4) {
      links.push({ source: `n${i}`, target: `n${Math.floor(next() * count)}` })
    }
  }
  const nodes = [section('S', 300, 200, 2000, 2000, { columnGapSteps: 1 + Math.floor(next() * 10) }), ...cards]
  return { nodes, cards, links }
}

test('a node resized and then given its size back leaves the layout as it was', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed)
    const { nodes, cards, links } = scattered(next)
    const laidOut = autolayoutSections(nodes, links)
    const { id, measured } = cards[Math.floor(next() * cards.length)]
    const { width, height } = measured as { width: number; height: number }
    const changed = autolayoutSections(resized(laidOut, id, 40 + next() * 300, 30 + next() * 200), links)
    const back = autolayoutSections(resized(changed, id, width, height), links)
    for (const c of cards) {
      assert.deepEqual(at(back, c.id), at(laidOut, c.id), `seed ${seed}: ${c.id} moved`)
    }
    assert.deepEqual(sizeOf(back, 'S'), sizeOf(laidOut, 'S'), `seed ${seed}: the section changed size`)
  }
})

test('is idempotent and keeps every node on the grid, inside the section, overlapping none', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { nodes, cards, links } = scattered(random(seed))
    const once = autolayoutSections(nodes, links)
    assert.equal(autolayoutSections(once, links), once, `seed ${seed}: a second pass changed the layout`)

    const s = byId(once, 'S')
    const { width, height } = s.style as { width: number; height: number }
    // Sizes as the grid takes them: one a hair past a grid line counts as on it.
    const boxes = cards.map((c) => {
      const { width: w, height: h } = c.measured as { width: number; height: number }
      return { ...at(once, c.id), width: ceilToGrid(w), height: ceilToGrid(h) }
    })
    for (const b of boxes) {
      assert.equal(b.x % GRID_STEP, 0, `seed ${seed}: x off the grid`)
      assert.equal(b.y % GRID_STEP, 0, `seed ${seed}: y off the grid`)
      assert.ok(b.x >= GRID_STEP && b.x + b.width <= width - GRID_STEP, `seed ${seed}`)
      assert.ok(b.y >= 4 * GRID_STEP && b.y + b.height <= height - GRID_STEP, `seed ${seed}`)
    }
    for (const [i, p] of boxes.entries()) {
      for (const q of boxes.slice(i + 1)) {
        const apart = p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y
        assert.ok(apart, `seed ${seed}: two nodes overlap`)
      }
    }
  }
})
