// The node-context-menu Delete button goes through useReactFlow().deleteElements(),
// which flow-editor.tsx also feeds a `nodeTypes` map that is deliberately
// rebuilt (and remounts every node) whenever the SET of node types on the
// canvas changes -- see node-wrapper.tsx's buildNodeTypes and
// node-type-keys.ts. Deleting the last node of a type is exactly the case
// that shrinks that set, so it is the one place a delete and a full node
// remount happen from the same state update. These tests exist to prove that
// interaction does not swallow the delete, against a real DOM and the real
// @xyflow/react library -- not a description of app wiring someone would
// otherwise only find out about by clicking through it.
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
  select: (nodeId: string) => Promise<void>
  clickDelete: () => Promise<void>
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
