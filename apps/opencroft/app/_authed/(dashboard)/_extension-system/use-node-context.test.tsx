// What a node reads from a wired input on the canvas: the value the source's
// `exposeOutput` returned, live values included, and the same context object
// for as long as that value is unchanged.
//
// The real hook is mounted inside a real React Flow store against a DOM, and
// the graph is changed through the store the way the canvas changes it.
import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import type { Edge, Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlowProvider, useStoreApi } = await import('@xyflow/react')
const { useNodeContext } = await import('./use-node-context')
const { getStream } = await import('@/app/_authed/(extension-runtime)/_client/stream')
const { loadedDeclaration } = await import('@/app/_authed/(extension-runtime)/_client/loaded-declaration')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type ExtensionDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').ExtensionDeclaration
type ResolvedContext = import('@/app/_authed/(extension-runtime)/_types').ResolvedContext
type FlowStore = ReturnType<typeof useStoreApi>

const component = () => null

const declaration: ExtensionDeclaration = {
  manifest: {},
  handleTypes: [
    { id: 'signal', label: 'Signal', color: 'blue' },
    { id: 'info', label: 'Info', color: 'green' },
  ],
  nodes: [
    {
      type: 'source',
      name: 'Source',
      component,
      handles: [
        { id: 'signal-out', role: 'source', handleType: 'signal' },
        { id: 'info-out', role: 'source', handleType: 'info' },
      ],
      exposeOutput: (handleId, data, _type, nodeId) => {
        if (handleId === 'signal-out') {
          return getStream<string>(nodeId, 'signal-out')
        }
        // A fresh object on every call, as most outputs are.
        return handleId === 'info-out' ? { host: data.host } : undefined
      },
    },
    {
      type: 'sink',
      name: 'Sink',
      component,
      handles: [
        { id: 'signal-in', role: 'target', handleType: 'signal' },
        { id: 'info-in', role: 'target', handleType: 'info' },
      ],
    },
  ],
}

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data }
}

function edge(source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return { id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }
}

const initialNodes = [
  node('source-1', 'acme.media.source', { host: 'tcp://10.0.0.7' }),
  node('sink-1', 'acme.media.sink'),
  node('bystander-1', 'acme.media.sink'),
]
const initialEdges = [
  edge('source-1', 'signal-out', 'sink-1', 'signal-in'),
  edge('source-1', 'info-out', 'sink-1', 'info-in'),
]

let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  extensionRegistry.register(loadedDeclaration(declaration, { id: 'acme.media', folder: 'acme.media' }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  extensionRegistry.clear()
})

async function mount(targetHandleId: string) {
  let context: ResolvedContext | null = null
  let store: FlowStore | undefined
  function Probe() {
    context = useNodeContext('sink-1', targetHandleId)
    store = useStoreApi()
    return null
  }
  root = createRoot(dom.container)
  await act(async () => {
    root?.render(createElement(ReactFlowProvider, { initialNodes, initialEdges, children: createElement(Probe) }))
  })
  return {
    context: () => context,
    node: (id: string) => store?.getState().nodes.find((n) => n.id === id),
    // Writes the store the way a controlled canvas does when its nodes change.
    update: (change: (nodes: Node[]) => Node[]) =>
      act(async () => {
        assert.ok(store)
        const { nodes, setNodes } = store.getState()
        setNodes(change(nodes))
      }),
  }
}

test('a stream exposed on an output reaches the consumer as the live stream', async () => {
  const probe = await mount('signal-in')

  const stream = getStream<string>('source-1', 'signal-out')
  const value = probe.context()?.value as typeof stream | undefined
  assert.equal(value, stream)

  const received: string[] = []
  const unsubscribe = value?.subscribe((chunk) => received.push(chunk))
  stream.broadcast('hello')
  unsubscribe?.()
  assert.deepEqual(received, ['hello'])
})

test('moving an unrelated node keeps the same context object', async () => {
  const probe = await mount('info-in')
  const before = probe.context()
  assert.deepEqual(before?.value, { host: 'tcp://10.0.0.7' })

  await probe.update((nodes) => nodes.map((n) => (n.id === 'bystander-1' ? { ...n, position: { x: 40, y: 40 } } : n)))

  assert.deepEqual(probe.node('bystander-1')?.position, { x: 40, y: 40 })
  assert.equal(probe.context(), before)
})

test('a change to the source data hands the consumer a new context with the new value', async () => {
  const probe = await mount('info-in')
  const before = probe.context()

  await probe.update((nodes) =>
    nodes.map((n) => (n.id === 'source-1' ? { ...n, data: { host: 'tcp://10.0.0.8' } } : n)),
  )

  assert.notEqual(probe.context(), before)
  assert.deepEqual(probe.context()?.value, { host: 'tcp://10.0.0.8' })
})
