// What an extension's `useGraphNodes` and `useGraphEdges` give on a canvas
// with a subgraph: the stored graph with its port chains joined, on whichever
// level is open, so a lookup over them answers as it does with the same nodes
// wired directly. The lookup is the one a Docker Application makes for its
// mounts: the edges into its `volumes-in`, and each one's source node.
//
// The hooks are the ones the host hands extensions, mounted in a real React
// Flow store that holds the open level's view, under the stored graph as the
// canvas provides it.
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import type { Edge, Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlowProvider } = await import('@xyflow/react')
const { extensionClientModules } = await import('@/app/_authed/(extension-runtime)/_client/host')
const { CanvasGraphContext } = await import('@/app/_authed/(extension-runtime)/_client/canvas-graph')
const { edgesOnCanvas, nodesOnLevel } = await import('@/app/_authed/(dashboard)/_canvas/subgraph-level')
const { SUBGRAPH_TYPE } = await import('@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared')

const { useGraphEdges, useGraphNodes } = extensionClientModules.canvas

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
})

function node(id: string, type: string, parentId?: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data, ...(parentId ? { parentId } : {}) }
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return { id, source, sourceHandle, target, targetHandle }
}

function subgraph(id: string, parentId?: string): Node {
  return node(id, SUBGRAPH_TYPE, parentId, {
    ports: {
      inputs: [{ id: 'vin', handleType: 'acme.docker.volume-mount', label: 'Volume' }],
      outputs: [{ id: 'vout', handleType: 'acme.docker.volume-mount', label: 'Volume' }],
    },
  })
}

const volume = (id: string, parentId?: string) => node(id, 'acme.docker.volume', parentId, { hostPath: `/srv/${id}` })
const application = (id: string, parentId?: string) => node(id, 'acme.docker.application', parentId)

/** The Application's mounts as it finds them: each Volume wired into its `volumes-in`, by its data. */
async function mountsSeen(stored: { nodes: Node[]; edges: Edge[] }, level: string | undefined, appId: string) {
  let seen: unknown[] = []
  function Probe() {
    const edges = useGraphEdges()
    const byId = new Map(useGraphNodes().map((n) => [n.id, n]))
    seen = edges
      .filter((e) => e.target === appId && e.targetHandle === 'volumes-in')
      .map((e) => ({ source: e.source, data: byId.get(e.source)?.data }))
    return null
  }
  root = createRoot(dom.container)
  await act(async () => {
    root?.render(
      createElement(
        CanvasGraphContext.Provider,
        { value: stored },
        createElement(ReactFlowProvider, {
          initialNodes: nodesOnLevel(stored.nodes, level, new Map()),
          initialEdges: edgesOnCanvas(stored.edges, stored.nodes),
          children: createElement(Probe),
        }),
      ),
    )
  })
  await act(async () => root?.unmount())
  root = undefined
  return seen
}

const DIRECT = [{ source: 'v', data: { hostPath: '/srv/v' } }]

test('wired directly, the Application finds its Volume', async () => {
  const stored = {
    nodes: [volume('v'), application('app')],
    edges: [edge('e1', 'v', 'volume-out', 'app', 'volumes-in')],
  }
  assert.deepEqual(await mountsSeen(stored, undefined, 'app'), DIRECT)
})

// Volume V at the top level, wired into subgraph S's input port, which feeds the Application inside S.
const INTO = {
  nodes: [volume('v'), subgraph('s'), application('app', 's')],
  edges: [edge('e1', 'v', 'volume-out', 's', 'in-vin'), edge('e2', 's', 'in-vin', 'app', 'volumes-in')],
}

test("through an input port, the Application finds the Volume outside, on the subgraph's canvas", async () => {
  assert.deepEqual(await mountsSeen(INTO, 's', 'app'), DIRECT)
})

test('through an input port, the Application finds the Volume outside, from the top level', async () => {
  assert.deepEqual(await mountsSeen(INTO, undefined, 'app'), DIRECT)
})

// Volume V inside subgraph S, out through its output port into the Application at the top level.
test('through an output port, the Application outside finds the Volume inside', async () => {
  const stored = {
    nodes: [subgraph('s'), volume('v', 's'), application('app')],
    edges: [edge('e1', 'v', 'volume-out', 's', 'out-vout'), edge('e2', 's', 'out-vout', 'app', 'volumes-in')],
  }
  assert.deepEqual(await mountsSeen(stored, undefined, 'app'), DIRECT)
  assert.deepEqual(await mountsSeen(stored, 's', 'app'), DIRECT)
})

test('the nodes are the stored ones: a member keeps its subgraph as its parent on its own canvas', async () => {
  let parent: string | undefined
  function Probe() {
    parent = useGraphNodes().find((n) => n.id === 'app')?.parentId
    return null
  }
  root = createRoot(dom.container)
  await act(async () => {
    root?.render(
      createElement(
        CanvasGraphContext.Provider,
        { value: INTO },
        createElement(ReactFlowProvider, {
          initialNodes: nodesOnLevel(INTO.nodes, 's', new Map()),
          initialEdges: edgesOnCanvas(INTO.edges, INTO.nodes),
          children: createElement(Probe),
        }),
      ),
    )
  })
  assert.equal(parent, 's')
})
