// What an input pin costs while the graph changes: only a pin that takes a
// plain value draws a field, and only that field follows the graph. A pin of
// any other type renders once and stays still while other nodes move.
//
// A value pin draws its field only while nothing is wired into it: an edge
// leaves no field at all, not even a disabled one, and the typed value comes
// back with the field when the edge goes.
//
// The pins are the host's `InputHandle`, drawn by a node component inside a
// real React Flow against a DOM; the graph is changed through the store the
// way the canvas changes it, and each pin's renders are counted with a
// `Profiler` around it.
import assert from 'node:assert/strict'
import test, { after, afterEach, beforeEach } from 'node:test'

import { NUMBER_TYPE } from '@opencroft/core/values'
import type { Edge, Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// @xyflow/react measures nodes with ResizeObserver and reads their transform
// as a DOMMatrixReadOnly; jsdom has neither. Stubs are enough to mount nodes.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
for (const scope of [globalThis, globalThis.window] as unknown as Record<string, unknown>[]) {
  scope.ResizeObserver = FakeResizeObserver
  scope.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
}

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement, Profiler } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider, useStoreApi } = await import('@xyflow/react')
const { InputHandle } = await import('./host')
const { loadedDeclaration } = await import('./loaded-declaration')
const { extensionRegistry } = await import('./registry')

type ExtensionDeclaration = import('./host').ExtensionDeclaration
type FlowStore = ReturnType<typeof useStoreApi>

after(() => dom.cleanup())

const renders = new Map<string, number>()

function countRender(id: string) {
  renders.set(id, (renders.get(id) ?? 0) + 1)
}

/** A sink drawing its input pins, the first two each inside a Profiler named by the pin. */
function Sink() {
  return createElement(
    'div',
    null,
    createElement(InputHandle, { type: NUMBER_TYPE, id: 'wire-only' }),
    createElement(
      Profiler,
      { id: 'info-in', onRender: countRender },
      createElement(InputHandle, { type: 'info', id: 'info-in' }),
    ),
    createElement(
      Profiler,
      { id: 'count-in', onRender: countRender },
      createElement(InputHandle, { type: NUMBER_TYPE, id: 'count-in' }),
    ),
  )
}

const component = () => null

const declaration: ExtensionDeclaration = {
  manifest: {},
  handleTypes: [{ id: 'info', label: 'Info', color: 'green' }],
  nodes: [
    {
      type: 'source',
      name: 'Source',
      component,
      handles: [
        { id: 'info-out', role: 'source', handleType: 'info' },
        { id: 'count-out', role: 'source', handleType: NUMBER_TYPE },
      ],
      exposeOutput: (_handleId, data) => ({ host: data.host }),
    },
    {
      type: 'sink',
      name: 'Sink',
      component: Sink,
      handles: [
        { id: 'info-in', role: 'target', handleType: 'info' },
        { id: 'count-in', role: 'target', handleType: NUMBER_TYPE, default: 3 },
        { id: 'wire-only', role: 'target', handleType: NUMBER_TYPE, inline: false },
      ],
    },
  ],
}

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data }
}

const defaultNodes = [
  node('source-1', 'acme.media.source', { host: 'tcp://10.0.0.7' }),
  node('sink-1', 'acme.media.sink', { inputs: { 'count-in': 7 } }),
  node('bystander-1', 'acme.media.source'),
]
const defaultEdges: Edge[] = [
  { id: 'info', source: 'source-1', sourceHandle: 'info-out', target: 'sink-1', targetHandle: 'info-in' },
]
const countInto = (targetHandle: string): Edge => ({
  id: `count-${targetHandle}`,
  source: 'source-1',
  sourceHandle: 'count-out',
  target: 'sink-1',
  targetHandle,
})
const nodeTypes = { 'acme.media.source': component, 'acme.media.sink': Sink }

let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  renders.clear()
  extensionRegistry.register(loadedDeclaration(declaration, { id: 'acme.media', folder: 'acme.media' }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  extensionRegistry.clear()
})

async function mount(edges: Edge[] = defaultEdges) {
  let store: FlowStore | undefined
  function StoreProbe() {
    store = useStoreApi()
    return null
  }
  root = createRoot(dom.container)
  await act(async () => {
    root?.render(
      createElement(
        ReactFlowProvider,
        null,
        createElement(ReactFlow, { defaultNodes, defaultEdges: edges, nodeTypes }),
        createElement(StoreProbe),
      ),
    )
  })
  return {
    moveBystander: () =>
      act(async () => {
        assert.ok(store)
        const { nodes, setNodes } = store.getState()
        setNodes(nodes.map((n) => (n.id === 'bystander-1' ? { ...n, position: { x: 40, y: 40 } } : n)))
      }),
    setEdges: (next: Edge[]) =>
      act(async () => {
        assert.ok(store)
        store.getState().setEdges(next)
      }),
  }
}

// Read as text and booleans: a failing assert on a jsdom element would print
// it, and inspecting a jsdom element walks the whole document.
const fieldValue = (handleId: string) =>
  dom.container.querySelector<HTMLInputElement>(`input[aria-label="${handleId}"]`)?.value
const fieldLabels = () => [...dom.container.querySelectorAll('input')].map((input) => input.getAttribute('aria-label'))

test('only a pin that takes a plain value draws a field', async () => {
  await mount()

  assert.deepEqual(fieldLabels(), ['count-in'])
  assert.equal(fieldValue('count-in'), '7')
})

test('a wired value pin draws no field, and removing the edge brings it back with the typed value', async () => {
  const flow = await mount([...defaultEdges, countInto('count-in')])
  assert.deepEqual(fieldLabels(), [], 'no field, disabled or not, while the edge feeds it')

  await flow.setEdges(defaultEdges)
  assert.deepEqual(fieldLabels(), ['count-in'])
  assert.equal(fieldValue('count-in'), '7')
})

test('a value pin that must be wired draws no field, wired or not', async () => {
  const flow = await mount([...defaultEdges, countInto('wire-only')])
  assert.deepEqual(fieldLabels(), ['count-in'])

  await flow.setEdges(defaultEdges)
  assert.deepEqual(fieldLabels(), ['count-in'])
})

test('a pin of another type does not re-render when another node moves', async () => {
  const flow = await mount()
  const before = { info: renders.get('info-in'), count: renders.get('count-in') }
  assert.ok(before.info, 'the pin rendered')

  await flow.moveBystander()

  assert.equal(renders.get('info-in'), before.info)
  // The value pin's field reads the graph, so the move reaches it: the count
  // above can see a re-render.
  assert.ok((renders.get('count-in') ?? 0) > (before.count ?? 0))
})
