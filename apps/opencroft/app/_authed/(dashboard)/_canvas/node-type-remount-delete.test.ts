// The node-context-menu Delete button goes through useReactFlow().deleteElements(),
// which flow-editor.tsx also feeds a `nodeTypes` map that is rebuilt whenever
// the SET of node types on the canvas changes -- see node-wrapper.tsx's
// buildNodeTypes and node-type-keys.ts. Deleting the last node of a type is
// exactly the case that shrinks that set, so it is the one place a delete and
// a new map happen from the same state update. These tests exist to prove that
// interaction does not swallow the delete, and that the nodes left behind stay
// mounted, against a real DOM and the real @xyflow/react library -- not a
// description of app wiring someone would otherwise only find out about by
// clicking through it.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})

// @xyflow/react measures nodes via ResizeObserver, which jsdom does not implement.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis.window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

// A node-type-map remount measures each node's transform; jsdom has no
// DOMMatrixReadOnly at all. A minimal stub -- only the identity transform, no
// real matrix math -- is enough to get through it.
class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly
;(globalThis.window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly

const { act, createElement, useMemo } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider, useNodesState, useReactFlow } = await import('@xyflow/react')
const { graphNodeTypes, nodeTypesKey, typesFromKey } = await import('./node-type-keys')
const { buildNodeTypes } = await import('./node-wrapper')

after(() => dom.cleanup())

type TestNode = import('@xyflow/react').Node

function makeNode(id: string, type: string): TestNode {
  return { id, type, position: { x: 0, y: 0 }, data: {}, selected: false }
}

interface Harness {
  nodeCount: () => number
  add: (node: TestNode) => Promise<void>
  select: (nodeId: string) => Promise<void>
  clickDelete: () => Promise<void>
}

// The element a node's component draws, under the flow library's own node
// element. It is replaced exactly when the component remounts.
function drawnElement(nodeId: string): Element {
  const element = dom.container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)?.firstElementChild
  assert.ok(element, `node ${nodeId} is drawn`)
  return element
}

// Selecting and deleting are kept as two separately committed steps here,
// matching two separate real clicks: opening the context menu (which selects
// the node, per flow-editor.tsx's openNodeMenu) commits and renders before
// the user's second click on the now-visible Delete button can happen. Racing
// both against the same render, in one queued microtask, would test the
// harness's own timing rather than the app's.
async function mountHarness(initialNodes: TestNode[], useAppNodeTypes: boolean): Promise<Harness> {
  let latestNodes: TestNode[] = initialNodes
  let latestSetNodes: ((updater: (nds: TestNode[]) => TestNode[]) => void) | null = null
  let latestOnDeleteSelected: (() => void) | null = null

  function FlowHarness() {
    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
    const { deleteElements } = useReactFlow()
    latestNodes = nodes as TestNode[]
    latestSetNodes = setNodes as typeof latestSetNodes

    // Mirrors flow-editor.tsx's own memoization exactly, when exercising the
    // app's actual nodeTypes; the control path passes none at all.
    const graphTypesKey = useMemo(() => nodeTypesKey(graphNodeTypes(nodes)), [nodes])
    const nodeTypes = useMemo(
      () => (useAppNodeTypes ? buildNodeTypes(typesFromKey(graphTypesKey)) : undefined),
      [graphTypesKey],
    )

    // Exactly flow-editor.tsx's onDeleteSelected, recreated fresh every
    // render as a real useCallback would be.
    latestOnDeleteSelected = () => {
      const targets = nodes.filter((n) => n.selected).map((n) => ({ id: n.id }))
      if (targets.length > 0) {
        deleteElements({ nodes: targets })
      }
    }

    return createElement(ReactFlow, { nodes, nodeTypes, onNodesChange, fitView: false })
  }

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))

  await act(async () => {
    root.render(createElement(ReactFlowProvider, null, createElement(FlowHarness, null)))
  })

  return {
    nodeCount: () => latestNodes.length,
    add: async (node: TestNode) => {
      await act(async () => {
        latestSetNodes?.((nds) => [...nds, node])
      })
    },
    select: async (nodeId: string) => {
      await act(async () => {
        latestSetNodes?.((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })))
      })
    },
    clickDelete: async () => {
      await act(async () => {
        latestOnDeleteSelected?.()
      })
    },
  }
}

test('CONTROL: deleteElements works with no custom nodeTypes involved', async () => {
  const harness = await mountHarness([makeNode('a', 'default'), makeNode('b', 'default')], false)
  assert.equal(harness.nodeCount(), 2)

  await harness.select('a')
  await harness.clickDelete()

  assert.equal(harness.nodeCount(), 1)
})

test('deleting one node when a same-type sibling remains (nodeTypes identity does not change)', async () => {
  const harness = await mountHarness([makeNode('a', 'type-a'), makeNode('b', 'type-a')], true)
  assert.equal(harness.nodeCount(), 2)

  await harness.select('a')
  await harness.clickDelete()

  assert.equal(harness.nodeCount(), 1)
})

test('deleting one node of two different types removes exactly that node', async () => {
  const harness = await mountHarness([makeNode('a', 'type-a'), makeNode('b', 'type-b')], true)
  assert.equal(harness.nodeCount(), 2)

  await harness.select('a')
  await harness.clickDelete()

  assert.equal(harness.nodeCount(), 1)
})

test('deleting the only node of its type (nodeTypes shrinks to empty) still removes it', async () => {
  const harness = await mountHarness([makeNode('solo', 'type-solo')], true)
  assert.equal(harness.nodeCount(), 1)

  await harness.select('solo')
  await harness.clickDelete()

  assert.equal(
    harness.nodeCount(),
    0,
    'deleting the last node of a type changes nodeTypes identity -- must not swallow the delete',
  )
})

// Each harness stays mounted until the file ends, so these use node ids no
// other test draws.
//
// Elements are compared with `===` inside assert.ok: a failing assert.equal on
// two DOM elements renders both, and through them the whole document.
test('a node of a type new to the canvas leaves the nodes already drawn mounted', async () => {
  const harness = await mountHarness([makeNode('stay-1', 'type-stay'), makeNode('other-1', 'type-other')], true)
  const stay = drawnElement('stay-1')
  const other = drawnElement('other-1')

  await harness.add(makeNode('new-1', 'type-new'))

  assert.equal(harness.nodeCount(), 3)
  assert.ok(drawnElement('stay-1') === stay, 'a node of an unchanged type keeps its component')
  assert.ok(drawnElement('other-1') === other, 'a node of an unchanged type keeps its component')
})

test('deleting the last node of a type leaves the other nodes mounted', async () => {
  const harness = await mountHarness([makeNode('stay-2', 'type-stay'), makeNode('gone-2', 'type-gone')], true)
  const stay = drawnElement('stay-2')

  await harness.select('gone-2')
  await harness.clickDelete()

  assert.equal(harness.nodeCount(), 1)
  assert.ok(drawnElement('stay-2') === stay, 'the remaining node keeps its component')
})

test('a type keeps one component across node-type maps', () => {
  const before = buildNodeTypes(['type-a'])
  const after = buildNodeTypes(['type-a', 'type-b'])
  assert.equal(after['type-a'], before['type-a'])
  assert.notEqual(after['type-b'], after['type-a'])
})
