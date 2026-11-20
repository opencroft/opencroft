// The hook against a real DOM and React: which tab lays out, when, and how
// the layout is written.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { Edge, Node } from '@xyflow/react'

import type { WriteOptions } from '@/app/_authed/(dashboard)/_canvas/live-graph'
import { SECTION_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AUTOLAYOUT_SETTLE_MS, useSectionAutolayout } = await import('./use-section-autolayout')

after(() => dom.cleanup())

function startNodes(): Node[] {
  return [
    {
      id: 'S',
      type: SECTION_TYPE,
      position: { x: 0, y: 0 },
      style: { width: 400, height: 300 },
      data: { label: 'S', color: 'red', autolayout: true },
    },
    {
      id: 'A',
      type: 'acme.kit.log',
      parentId: 'S',
      position: { x: 100, y: 100 },
      measured: { width: 200, height: 60 },
      data: {},
    },
  ]
}

interface Harness {
  nodes: () => Node[]
  setNodes: (update: (nodes: Node[]) => Node[]) => void
  writes: WriteOptions[]
  unmount: () => void
}

async function mount(layoutWriter: boolean): Promise<Harness> {
  const writes: WriteOptions[] = []
  let current: Node[] = []
  let set: (update: (nodes: Node[]) => Node[]) => void = () => {}
  const edges: Edge[] = []
  const requestWrite = (options?: WriteOptions) => writes.push(options ?? {})
  function Canvas() {
    const [nodes, setNodes] = useState(startNodes)
    current = nodes
    set = setNodes
    useSectionAutolayout({ nodes, edges, setNodes, requestWrite, layoutWriter })
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(createElement(Canvas)))
  return {
    nodes: () => current,
    setNodes: (update) => set(update),
    writes,
    unmount: () => root.unmount(),
  }
}

async function settle(): Promise<void> {
  // biome-ignore lint/plugin/noTestFixedTime: waits out the autolayout's own settle delay plus a margin
  await act(() => new Promise((resolve) => setTimeout(resolve, AUTOLAYOUT_SETTLE_MS + 100)))
}

const positionOf = (h: Harness, id: string) => h.nodes().find((n) => n.id === id)?.position

test('the layout writer lays out once the nodes settle, as one untracked write, and then leaves them', async () => {
  const h = await mount(true)
  assert.deepEqual(positionOf(h, 'A'), { x: 100, y: 100 })
  await settle()
  assert.deepEqual(positionOf(h, 'A'), { x: 10, y: 40 })
  assert.deepEqual(h.writes, [{ untracked: true }])
  await settle()
  assert.equal(h.writes.length, 1)
  h.unmount()
})

test('a tab that is not the layout writer changes nothing', async () => {
  const h = await mount(false)
  await settle()
  assert.deepEqual(positionOf(h, 'A'), { x: 100, y: 100 })
  assert.deepEqual(h.writes, [])
  h.unmount()
})

test('waits while a node is dragged, and lays out after the drop', async () => {
  const h = await mount(true)
  await act(async () => h.setNodes((ns) => ns.map((n) => (n.id === 'A' ? { ...n, dragging: true } : n))))
  await settle()
  assert.deepEqual(positionOf(h, 'A'), { x: 100, y: 100 })
  assert.deepEqual(h.writes, [])
  await act(async () => h.setNodes((ns) => ns.map((n) => (n.id === 'A' ? { ...n, dragging: false } : n))))
  await settle()
  assert.deepEqual(positionOf(h, 'A'), { x: 10, y: 40 })
  h.unmount()
})

test('waits while a node is resized', async () => {
  const h = await mount(true)
  await act(async () => h.setNodes((ns) => ns.map((n) => (n.id === 'S' ? { ...n, resizing: true } : n))))
  await settle()
  assert.deepEqual(h.writes, [])
  h.unmount()
})

test('follows a node that changes size', async () => {
  const h = await mount(true)
  await settle()
  await act(async () =>
    h.setNodes((ns) => ns.map((n) => (n.id === 'A' ? { ...n, measured: { width: 200, height: 160 } } : n))),
  )
  await settle()
  const section = h.nodes().find((n) => n.id === 'S')
  assert.deepEqual(section?.style, { width: 220, height: 40 + 160 + 10 })
  assert.equal(h.writes.length, 2)
  h.unmount()
})
