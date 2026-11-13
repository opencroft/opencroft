// Which frames a node is inside, as the open canvas answers it: the same tree and the same
// type narrowing a node action's `containingNodes` applies on the server, and an answer that
// follows the node as it is placed in another frame, and only then.
//
// The real hook is mounted inside a real React Flow store against a DOM, and the graph is
// changed through the store the way the canvas changes it.
import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import type { Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlowProvider, useStoreApi } = await import('@xyflow/react')
const { useContainingNodes } = await import('./use-containing-nodes')
const { loadedDeclaration } = await import('@/app/_authed/(extension-runtime)/_client/loaded-declaration')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type ExtensionDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').ExtensionDeclaration
type FlowStore = ReturnType<typeof useStoreApi>

const component = () => null

const declaration: ExtensionDeclaration = {
  manifest: {},
  nodes: [
    { type: 'zone', name: 'Zone', category: 'Organization', component },
    { type: 'gadget', name: 'Gadget', component },
  ],
}

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  size?: { width: number; height: number },
  parentId?: string,
): Node {
  return {
    id,
    type,
    position: { x, y },
    data: { name: id },
    ...(size ? { style: size } : {}),
    ...(parentId ? { parentId } : {}),
  }
}

// gadget-1 is in zone-1, which is in section-1 at (100, 100).
const initialNodes = [
  node('section-1', 'builtin.core.section', 100, 100, { width: 600, height: 600 }),
  node('zone-1', 'acme.net.zone', 10, 40, { width: 400, height: 300 }, 'section-1'),
  node('zone-2', 'acme.net.zone', 1000, 0, { width: 400, height: 300 }),
  node('gadget-1', 'acme.net.gadget', 50, 50, undefined, 'zone-1'),
]

let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  extensionRegistry.register(loadedDeclaration(declaration, { id: 'acme.net', folder: 'acme.net' }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  extensionRegistry.clear()
})

async function mount(type?: string) {
  let held: { id: string; position: { x: number; y: number } }[] = []
  let store: FlowStore | undefined
  function Probe() {
    held = useContainingNodes('gadget-1', type)
    store = useStoreApi()
    return null
  }
  root = createRoot(dom.container)
  await act(async () => {
    root?.render(createElement(ReactFlowProvider, { initialNodes, children: createElement(Probe) }))
  })
  const change = (id: string, patch: Partial<Node>) =>
    act(async () => {
      assert.ok(store)
      const { nodes, setNodes } = store.getState()
      setNodes(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)))
    })
  return {
    ids: () => held.map((n) => n.id),
    held: () => held,
    change,
  }
}

test('the frames the node is inside, innermost first, each where it is drawn', async () => {
  const probe = await mount()
  assert.deepEqual(
    probe.held().map(({ id, position }) => ({ id, position })),
    [
      { id: 'zone-1', position: { x: 110, y: 140 } },
      { id: 'section-1', position: { x: 100, y: 100 } },
    ],
  )
})

test('a bare type is the node’s own extension’s; a qualified one any extension’s', async () => {
  assert.deepEqual((await mount('zone')).ids(), ['zone-1'])
  await act(async () => root?.unmount())
  assert.deepEqual((await mount('builtin.core.section')).ids(), ['section-1'])
})

test('the answer follows the node when it is placed in another frame', async () => {
  const probe = await mount('zone')
  await probe.change('gadget-1', { parentId: 'zone-2', position: { x: 100, y: 100 } })
  assert.deepEqual(probe.ids(), ['zone-2'])
  await probe.change('gadget-1', { parentId: undefined, position: { x: 800, y: 100 } })
  assert.deepEqual(probe.ids(), [], 'placed at the top level')
})

test('a frame moved or grown over the node does not take it in', async () => {
  const probe = await mount('zone')
  await probe.change('zone-2', { position: { x: 100, y: 100 }, style: { width: 1000, height: 1000 } })
  assert.deepEqual(probe.ids(), ['zone-1'])
})
