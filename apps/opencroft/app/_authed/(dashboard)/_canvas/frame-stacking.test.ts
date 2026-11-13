// A frame stays below the nodes it holds, selected or not. These tests hand
// the nodes to a real React Flow store and read the stacking order it
// computes, so a change to how far React Flow lifts a selected node fails here.
import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const win = globalThis.window as unknown as Window & typeof globalThis

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlowProvider, useStoreApi } = await import('@xyflow/react')
const { frameZ, stackedFrame } = await import('./frame-stacking')
const { FRAME_Z_INDEX } = await import('@/app/_authed/(extension-runtime)/_frames')
const FRAME_Z = frameZ(0)

type Root = ReturnType<typeof createRoot>

const roots: Root[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  dom.container.replaceChildren()
})

after(() => dom.cleanup())

interface FlowNode {
  id: string
  position: { x: number; y: number }
  data: Record<string, unknown>
  parentId?: string
  selected?: boolean
  zIndex?: number
}

/** The stacking order React Flow computes for each node, by id. */
async function stackingOf(nodes: FlowNode[]): Promise<Map<string, number>> {
  const container = win.document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  let read: Map<string, number> | undefined
  function Probe() {
    const store = useStoreApi()
    read = new Map([...store.getState().nodeLookup].map(([id, node]) => [id, node.internals.z]))
    return null
  }
  await act(async () => {
    root.render(createElement(ReactFlowProvider, { initialNodes: nodes, children: createElement(Probe) }))
  })
  assert.ok(read, 'the probe read the store')
  return read
}

const at = { x: 0, y: 0 }

test('a selected frame stacks below an unselected node and below a selected one', async () => {
  const z = await stackingOf([
    stackedFrame<FlowNode>({ id: 'frame', position: at, data: {}, zIndex: FRAME_Z_INDEX, selected: true }),
    { id: 'inside', position: { x: 20, y: 40 }, data: {} },
    { id: 'picked', position: { x: 60, y: 40 }, data: {}, selected: true },
  ])
  assert.equal(z.get('frame'), FRAME_Z)
  assert.ok((z.get('frame') as number) < (z.get('inside') as number))
  assert.ok((z.get('frame') as number) < (z.get('picked') as number))
})

test('an unselected frame stacks at the frame order, whatever z-index it was stored with', async () => {
  const z = await stackingOf([
    stackedFrame<FlowNode>({ id: 'frame', position: at, data: {}, zIndex: 5 }),
    { id: 'n', position: at, data: {} },
  ])
  assert.equal(z.get('frame'), FRAME_Z)
  assert.ok((z.get('frame') as number) < (z.get('n') as number))
})

test('a frame already stacked where it belongs is returned as the same object', () => {
  const frame = { id: 'frame', zIndex: FRAME_Z }
  assert.equal(stackedFrame(frame), frame)
})

// The tree as the canvas hands it over: a section, a section inside it, a
// card in each, and a card at the top level dragged over them.
async function nested(selectedFrame?: 'outer' | 'inner'): Promise<Map<string, number>> {
  return stackingOf([
    stackedFrame<FlowNode>({ id: 'outer', position: at, data: {}, selected: selectedFrame === 'outer' }, 0),
    stackedFrame<FlowNode>(
      { id: 'inner', parentId: 'outer', position: { x: 20, y: 40 }, data: {}, selected: selectedFrame === 'inner' },
      1,
    ),
    { id: 'in-outer', parentId: 'outer', position: { x: 300, y: 40 }, data: {} },
    { id: 'in-inner', parentId: 'inner', position: { x: 10, y: 40 }, data: {} },
    { id: 'over', position: { x: 30, y: 60 }, data: {} },
  ])
}

test('a nested frame stacks above the frame it is in and below every card, its own and the top-level ones', async () => {
  for (const selected of [undefined, 'outer', 'inner'] as const) {
    const z = await nested(selected)
    const [outer, inner] = [z.get('outer') as number, z.get('inner') as number]
    assert.ok(outer < inner, `outer below inner, ${selected ?? 'none'} selected`)
    for (const card of ['in-outer', 'in-inner', 'over']) {
      assert.ok(inner < (z.get(card) as number), `inner below ${card}, ${selected ?? 'none'} selected`)
    }
  }
})

test('handed over as stored, React Flow stacks a nested frame level with the cards over it', async () => {
  // The control: both frames at the z-index a frame is stored with.
  const z = await stackingOf([
    { id: 'outer', position: at, data: {}, zIndex: FRAME_Z_INDEX },
    { id: 'inner', parentId: 'outer', position: { x: 20, y: 40 }, data: {}, zIndex: FRAME_Z_INDEX },
    { id: 'over', position: { x: 30, y: 60 }, data: {} },
  ])
  assert.ok((z.get('inner') as number) >= (z.get('over') as number))
})

test('without the frame stacking, React Flow draws a selected frame above the nodes it holds', async () => {
  // The control: what the canvas would show if it handed the frame over as stored.
  const z = await stackingOf([
    { id: 'frame', position: at, data: {}, zIndex: FRAME_Z, selected: true },
    { id: 'inside', position: { x: 20, y: 40 }, data: {} },
  ])
  assert.ok((z.get('frame') as number) > (z.get('inside') as number))
})
