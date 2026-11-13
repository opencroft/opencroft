// The Outline lists frames with their members beneath them, and a node
// selected from outside gets its row shown: the frames it lies in open and the
// row scrolls into view, while a frame collapsed over it later stays closed.
// Mounted in a DOM, with the host's collapsed state held by a wrapper as the
// app holds it.

import assert from 'node:assert/strict'
import { after, afterEach, before, mock, test } from 'node:test'

import { JSDOM } from 'jsdom'
import { Box } from 'lucide-react'

import type { GraphOutlineDrop, GraphOutlineItem, GraphOutlineProps } from './graph-outline'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

// The rows each scrollIntoView call was made on; jsdom lays nothing out and has no scrollIntoView.
const scrolled: string[] = []

before(() => {
  // The animation frame functions for the collapsible's open transition.
  const names = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'MouseEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]
  for (const name of [...names, 'navigator', 'CSS', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  // jsdom has no CSS.escape; the ids here need no escaping.
  Object.defineProperty(globalThis, 'CSS', { value: { escape: (s: string) => s }, configurable: true })
  dom.window.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute('data-outline-id') ?? '')
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true
})

after(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete globals[name]
    }
  }
  dom.window.close()
})

let unmount: (() => Promise<void>) | null = null

afterEach(async () => {
  await unmount?.()
  unmount = null
  scrolled.length = 0
})

// outer holds inner, inner holds db; top is at the top level.
const ITEMS: GraphOutlineItem[] = [
  {
    id: 'outer',
    label: 'Outer',
    typeName: 'Section',
    icon: Box,
    members: [{ id: 'inner', label: 'Inner', icon: Box, members: [{ id: 'db', label: 'Database', icon: Box }] }],
  },
  { id: 'top', label: 'Top', icon: Box },
]

// Imported after the DOM exists: react-dom binds to the globals it finds when first loaded.
async function mount(initiallyCollapsed: string[], more: Partial<GraphOutlineProps> = {}) {
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { GraphOutline } = await import('./graph-outline')

  let select: (id: string | null) => void = () => {}
  let collapsed: ReadonlySet<string> = new Set()
  function Host() {
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [state, setState] = useState<ReadonlySet<string>>(() => new Set(initiallyCollapsed))
    select = setSelectedId
    collapsed = state
    return createElement(GraphOutline, {
      items: ITEMS,
      selectedId,
      collapsed: state,
      onCollapsedChange: setState,
      ...more,
    })
  }

  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  await act(async () => root.render(createElement(Host)))
  unmount = async () => {
    await act(async () => root.unmount())
  }
  const row = (id: string) => container.querySelector(`[data-outline-id="${id}"]`)
  return {
    row,
    text: () => container.textContent ?? '',
    collapsed: () => collapsed,
    select: async (id: string | null) => act(async () => select(id)),
    toggle: async (label: string) => {
      const trigger = container.querySelector(`button[aria-label$=" ${label}"]`) as HTMLElement
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    },
  }
}

test('frames list their members beneath them with no member count; a collapsed frame hides them', async () => {
  const open = await mount([])
  assert.ok(open.row('db'), 'a member of a nested frame is listed')
  assert.match(open.row('outer')?.textContent ?? '', /Section/, 'the frame row shows its type')
  assert.doesNotMatch(open.row('outer')?.textContent ?? '', /\d|member/, 'and no count of its members')
  await unmount?.()
  const closed = await mount(['outer'])
  assert.ok(closed.row('outer'))
  assert.equal(closed.row('inner'), null)
  assert.equal(closed.row('db'), null)
})

// Plain nodes and containers interleaved, on the top level and inside a frame.
const MIXED: GraphOutlineItem[] = [
  { id: 'a', label: 'A', icon: Box },
  {
    id: 'frame',
    label: 'Frame',
    icon: Box,
    members: [
      { id: 'm1', label: 'M1', icon: Box },
      { id: 'empty', label: 'Empty', icon: Box, members: [] },
      { id: 'm2', label: 'M2', icon: Box },
    ],
  },
  { id: 'b', label: 'B', icon: Box },
  { id: 'sub', label: 'Sub', icon: Box, subgraph: true, members: [] },
  { id: 'c', label: 'C', icon: Box },
]

test('on every level containers are listed first, then plain nodes, each group in the given order', async () => {
  await mount([], { items: MIXED })
  const order = [...document.querySelectorAll<HTMLElement>('[data-outline-id]')].map((row) => row.dataset.outlineId)
  assert.deepEqual(order, ['frame', 'empty', 'm1', 'm2', 'sub', 'a', 'b', 'c'])
})

test('selecting a node from outside opens the frames it lies in and scrolls its row into view, once', async () => {
  const outline = await mount(['outer', 'inner'])
  await outline.select('db')
  assert.deepEqual([...outline.collapsed()], [])
  assert.ok(outline.row('db'))
  assert.deepEqual(scrolled, ['db'])
  await outline.toggle('Outer')
  assert.deepEqual([...outline.collapsed()], ['outer'], 'a frame collapsed over the selected row stays collapsed')
  assert.deepEqual(scrolled, ['db'])
})

test('a frame the selected node is not in stays as it is', async () => {
  const outline = await mount(['outer'])
  await outline.select('top')
  assert.deepEqual([...outline.collapsed()], ['outer'])
  assert.deepEqual(scrolled, ['top'])
})

// The line a row is drawn on: the drag source and drop target.
function lineOf(id: string): HTMLElement {
  const line = document.querySelector(`[data-outline-row="${id}"]`)
  assert.ok(line, `row ${id} rendered`)
  return line as HTMLElement
}

// jsdom lays nothing out; a line given a box answers the pointer's height within it.
function giveBox(el: HTMLElement, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top }) as DOMRect
}

// One native drag event; jsdom has no DragEvent, so a plain event carries what React reads.
async function dragEvent(type: string, target: Element, y = 0): Promise<Event> {
  const { act } = await import('react')
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    clientX: 10,
    clientY: y,
    dataTransfer: { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' },
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

// A mouse drag of `from` released over `to` at height `y`; whether `to` took the drag.
async function dragOnto(from: string, to: Element, y = 0): Promise<boolean> {
  await dragEvent('dragstart', lineOf(from))
  const over = await dragEvent('dragover', to, y)
  await dragEvent('drop', to, y)
  await dragEvent('dragend', lineOf(from))
  return over.defaultPrevented
}

async function mountMoving(initiallyCollapsed: string[] = []) {
  const moves: [string, GraphOutlineDrop][] = []
  const outline = await mount(initiallyCollapsed, { onMove: (id, drop) => moves.push([id, drop]) })
  return { ...outline, moves }
}

test('a node dropped onto a frame row goes into that frame, nested ones included', async () => {
  const outline = await mountMoving()
  assert.equal(await dragOnto('top', lineOf('outer')), true)
  assert.equal(await dragOnto('top', lineOf('inner')), true)
  assert.deepEqual(outline.moves, [
    ['top', { parentId: 'outer' }],
    ['top', { parentId: 'inner' }],
  ])
})

test('a plain node dropped anywhere on a frame row goes into that frame', async () => {
  const outline = await mountMoving()
  giveBox(lineOf('inner'), 100, 40)
  await dragOnto('top', lineOf('inner'), 102)
  await dragOnto('top', lineOf('inner'), 138)
  assert.deepEqual(outline.moves, [
    ['top', { parentId: 'inner' }],
    ['top', { parentId: 'inner' }],
  ])
})

test('a node dropped beside a member row goes into that member’s frame, next to it', async () => {
  const outline = await mountMoving()
  giveBox(lineOf('db'), 100, 20)
  await dragOnto('top', lineOf('db'), 104)
  assert.deepEqual(outline.moves, [['top', { parentId: 'inner', beside: { id: 'db', side: 'before' } }]])
})

test('a frame never goes into itself or a frame inside it, and offers no drop there', async () => {
  const outline = await mountMoving()
  assert.equal(await dragOnto('outer', lineOf('outer')), false)
  assert.equal(await dragOnto('outer', lineOf('inner')), false)
  assert.equal(await dragOnto('outer', lineOf('db')), false)
  assert.deepEqual(outline.moves, [])
})

test('a drop that leaves the node in the frame it is in reports nothing', async () => {
  const outline = await mountMoving()
  await dragOnto('db', lineOf('inner'))
  assert.deepEqual(outline.moves, [])
})

test('a member dragged gets a top-level zone that takes it out of every frame', async () => {
  const outline = await mountMoving()
  assert.equal(document.querySelector('[data-outline-top-level]'), null, 'no zone before a drag')
  await dragEvent('dragstart', lineOf('db'))
  const zone = document.querySelector('[data-outline-top-level]')
  assert.ok(zone, 'the zone shows while a member is dragged')
  await dragEvent('dragover', zone)
  await dragEvent('drop', zone)
  await dragEvent('dragend', lineOf('db'))
  assert.deepEqual(outline.moves, [['db', { parentId: null }]])
  assert.equal(document.querySelector('[data-outline-top-level]'), null, 'gone once the drag ends')
})

test('a top-level node dragged shows no top-level zone', async () => {
  await mountMoving()
  await dragEvent('dragstart', lineOf('top'))
  assert.equal(document.querySelector('[data-outline-top-level]'), null)
  await dragEvent('dragend', lineOf('top'))
})

test('rows do not drag without onMove', async () => {
  await mount([])
  assert.notEqual(lineOf('top').getAttribute('draggable'), 'true')
  await unmount?.()
  await mountMoving()
  assert.equal(lineOf('top').getAttribute('draggable'), 'true', 'control: with onMove the row drags')
})

// sub is a subgraph holding a frame (steps, which holds build) and run;
// section and top are on the top level beside it.
const LEVELS: GraphOutlineItem[] = [
  {
    id: 'sub',
    label: 'Deploy',
    typeName: 'Subgraph',
    icon: Box,
    subgraph: true,
    members: [
      { id: 'steps', label: 'Steps', icon: Box, members: [{ id: 'build', label: 'Build', icon: Box }] },
      { id: 'run', label: 'Run', icon: Box },
    ],
  },
  { id: 'section', label: 'Section', icon: Box, members: [] },
  { id: 'top', label: 'Top', icon: Box },
]

async function mountLevels(initiallyCollapsed: string[] = []) {
  const moves: [string, GraphOutlineDrop][] = []
  const outline = await mount(initiallyCollapsed, { items: LEVELS, onMove: (id, drop) => moves.push([id, drop]) })
  return { ...outline, moves }
}

test('a subgraph row carries the subgraph mark and no count, and expands onto its members like a frame', async () => {
  const open = await mountLevels()
  assert.ok(open.row('sub')?.querySelector('[data-outline-subgraph]'), 'the subgraph row is marked')
  assert.equal(open.row('sub')?.querySelector('[data-outline-subgraph]')?.getAttribute('aria-label'), 'Subgraph')
  assert.equal(open.row('section')?.querySelector('[data-outline-subgraph]'), null, 'control: a frame row is not')
  assert.doesNotMatch(open.row('sub')?.textContent ?? '', /\d|member/)
  assert.ok(open.row('build'), 'what it holds is listed at every depth')
  await open.toggle('Deploy')
  assert.deepEqual([...open.collapsed()], ['sub'])
  assert.equal(open.row('run'), null, 'collapsed, its members are not drawn')
})

test('a subgraph row is never dropped into: its middle puts a container beside it', async () => {
  const outline = await mountLevels()
  assert.equal(lineOf('sub').dataset.outlineFrame, undefined)
  giveBox(lineOf('sub'), 100, 40)
  await dragOnto('section', lineOf('sub'), 120)
  assert.deepEqual(outline.moves, [['section', { parentId: null, beside: { id: 'sub', side: 'after' } }]])
})

test("a frame row's top and bottom quarters put a container beside the frame, its middle into it", async () => {
  const outline = await mountLevels()
  giveBox(lineOf('section'), 100, 40)
  await dragOnto('sub', lineOf('section'), 105)
  await dragOnto('sub', lineOf('section'), 135)
  await dragOnto('sub', lineOf('section'), 120)
  assert.deepEqual(outline.moves, [
    ['sub', { parentId: null, beside: { id: 'section', side: 'before' } }],
    ['sub', { parentId: null, beside: { id: 'section', side: 'after' } }],
    ['sub', { parentId: 'section' }],
  ])
})

test('a row drops beside rows of its own kind only: containers beside containers, plain nodes beside plain nodes', async () => {
  const outline = await mountLevels()
  assert.equal(await dragOnto('top', lineOf('sub')), false, 'a plain node over a subgraph row')
  assert.equal(await dragOnto('section', lineOf('top')), false, 'a container over a plain row')
  assert.equal(await dragOnto('steps', lineOf('run')), false, 'inside a subgraph too')
  assert.deepEqual(outline.moves, [])
  assert.equal(await dragOnto('section', lineOf('sub')), true, 'control: a container over a container row')
})

test('no row offers a drop on a row of another level, either way', async () => {
  const outline = await mountLevels()
  assert.equal(await dragOnto('top', lineOf('run')), false)
  assert.equal(await dragOnto('top', lineOf('steps')), false)
  assert.equal(await dragOnto('top', lineOf('build')), false)
  assert.equal(await dragOnto('run', lineOf('section')), false)
  assert.equal(await dragOnto('build', lineOf('top')), false)
  assert.equal(await dragOnto('steps', lineOf('sub')), false)
  assert.deepEqual(outline.moves, [])
  assert.equal(await dragOnto('top', lineOf('section')), true, 'control: a frame on the same level takes it')
})

// The rows drawing an insert line or an into-frame ring now.
function marked(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-outline-row]')]
    .filter((line) => line.querySelector(':scope > div.bg-primary') || line.classList.contains('ring-primary'))
    .map((line) => line.dataset.outlineRow ?? '')
}

test('the pointer moving onto a row of another level clears the drop drawn on its own level', async () => {
  await mountLevels()
  giveBox(lineOf('steps'), 100, 40)
  await dragEvent('dragstart', lineOf('run'))
  await dragEvent('dragover', lineOf('steps'), 102)
  assert.deepEqual(marked(), ['steps'])
  await dragEvent('dragover', lineOf('section'))
  assert.deepEqual(marked(), [])
  await dragEvent('dragend', lineOf('run'))
})

test('the gap between two rows keeps the drop drawn on the row the pointer left', async () => {
  await mountLevels()
  giveBox(lineOf('steps'), 100, 40)
  await dragEvent('dragstart', lineOf('run'))
  await dragEvent('dragover', lineOf('steps'), 102)
  await dragEvent('dragover', lineOf('steps').closest('ul') as Element)
  assert.deepEqual(marked(), ['steps'])
  await dragEvent('dragend', lineOf('run'))
})

test('the pointer leaving the Outline, onto another list beside it, clears the drop drawn in it', async () => {
  await mountLevels()
  const beside = document.createElement('div')
  beside.setAttribute('data-row-drag-source', '')
  document.body.append(beside)
  try {
    giveBox(lineOf('steps'), 100, 40)
    await dragEvent('dragstart', lineOf('run'))
    await dragEvent('dragover', lineOf('steps'), 102)
    assert.deepEqual(marked(), ['steps'])
    await dragEvent('dragover', beside)
    assert.deepEqual(marked(), [])
    await dragEvent('dragend', lineOf('run'))
  } finally {
    beside.remove()
  }
})

test('inside a subgraph rows move as on the top level, and the zone is the top of the subgraph', async () => {
  const outline = await mountLevels()
  assert.equal(await dragOnto('run', lineOf('steps')), true)
  await dragEvent('dragstart', lineOf('build'))
  const zone = document.querySelector('[data-outline-top-level]')
  assert.equal(zone?.textContent, 'Move to top of Deploy')
  await dragEvent('dragover', zone as Element)
  await dragEvent('drop', zone as Element)
  await dragEvent('dragend', lineOf('build'))
  assert.deepEqual(outline.moves, [
    ['run', { parentId: 'steps' }],
    ['build', { parentId: 'sub' }],
  ])
})

test('a node at the top of a subgraph dragged shows no zone', async () => {
  await mountLevels()
  await dragEvent('dragstart', lineOf('run'))
  assert.equal(document.querySelector('[data-outline-top-level]'), null)
  await dragEvent('dragend', lineOf('run'))
  await dragEvent('dragstart', lineOf('build'))
  assert.ok(document.querySelector('[data-outline-top-level]'), 'control: one in a frame inside it does')
  await dragEvent('dragend', lineOf('build'))
})

test("a right-click on a row asks the host for the node's menu at the pointer", async () => {
  const { act } = await import('react')
  const menus: [string, { x: number; y: number }][] = []
  const outline = await mount([], { onRowContextMenu: (id, point) => menus.push([id, point]) })
  const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })
  await act(async () => {
    outline.row('inner')?.dispatchEvent(event)
  })
  assert.deepEqual(menus, [['inner', { x: 30, y: 40 }]])
  assert.equal(event.defaultPrevented, true, "the browser's own menu stays shut")
})

// A finger on `target`, as a browser raises it: the pointer event, then the touch.
async function touch(type: 'touchstart' | 'touchend', target: Element, x: number, y: number): Promise<Event> {
  const { act } = await import('react')
  if (type === 'touchstart') {
    const pointer = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true })
    Object.assign(pointer, { pointerType: 'touch', clientX: x, clientY: y })
    await act(async () => {
      target.dispatchEvent(pointer)
    })
  }
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  const point = { clientX: x, clientY: y, target }
  Object.assign(
    event,
    type === 'touchstart' ? { touches: [point], changedTouches: [point] } : { touches: [], changedTouches: [point] },
  )
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

test('a long press held past the pickup opens the same menu, and its release is cancelled', async () => {
  const { act } = await import('react')
  mock.timers.enable({ apis: ['setTimeout'] })
  const menus: string[] = []
  const outline = await mount([], { onMove: () => {}, onRowContextMenu: (id) => menus.push(id) })
  const row = outline.row('db') as HTMLElement
  ;(document as unknown as Record<string, unknown>).elementFromPoint = () => row
  try {
    await touch('touchstart', row, 20, 20)
    await act(async () => mock.timers.tick(500))
    assert.deepEqual(menus, [], 'the pickup stage opens no menu')
    await act(async () => mock.timers.tick(500))
    assert.deepEqual(menus, ['db'])
    assert.equal((await touch('touchend', row, 20, 20)).defaultPrevented, true)
  } finally {
    mock.timers.reset()
  }
})
