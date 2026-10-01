// A node's inputs as the open canvas has them: resolved from the page's own
// edges and source nodes, not from the `__resolvedContexts` the server writes
// into node data on save.
import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import type { Edge, Node } from '@xyflow/react'

import type { ExtensionDeclaration } from '@/app/_authed/(extension-runtime)/_client/host'
import { loadedDeclaration } from '@/app/_authed/(extension-runtime)/_client/loaded-declaration'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { resolveInputContexts } from './context-resolver'

const component = () => null

const declaration: ExtensionDeclaration = {
  manifest: {},
  handleTypes: [{ id: 'engine', label: 'Engine', color: 'blue' }],
  nodes: [
    {
      type: 'engine',
      name: 'Engine',
      component,
      handles: [
        { id: 'engine-out', role: 'source', handleType: 'engine' },
        { id: 'silent-out', role: 'source', handleType: 'engine' },
      ],
      exposeOutput: (handleId, data) => (handleId === 'engine-out' ? { host: data.host } : undefined),
    },
    {
      type: 'app',
      name: 'App',
      component,
      handles: [
        { id: 'engine-in', role: 'target', handleType: 'engine' },
        { id: 'spare-in', role: 'target', handleType: 'engine' },
      ],
    },
    {
      // Exposes an output built from its own input, as a node does when it
      // passes a connection on through itself.
      type: 'relay',
      name: 'Relay',
      component,
      handles: [
        { id: 'engine-in', role: 'target', handleType: 'engine' },
        { id: 'relay-out', role: 'source', handleType: 'engine' },
      ],
      exposeOutput: (handleId, _data, _type, _nodeId, contexts) => {
        const upstream = contexts['engine-in']?.value
        return handleId === 'relay-out' && upstream ? { via: upstream } : undefined
      },
    },
  ],
}

beforeEach(() => {
  extensionRegistry.register(loadedDeclaration(declaration, { id: 'acme.stack', folder: 'acme.stack' }))
})

afterEach(() => {
  extensionRegistry.clear()
})

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data }
}

function edge(source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return { id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }
}

const nodes = [
  node('engine-1', 'acme.stack.engine', { host: 'tcp://10.0.0.7' }),
  node('engine-2', 'acme.stack.engine', { host: 'tcp://10.0.0.8' }),
  node('app-1', 'acme.stack.app'),
]

test('an input resolves from the canvas edge and the source node as the page holds them', () => {
  const contexts = resolveInputContexts('app-1', {
    nodes,
    edges: [edge('engine-1', 'engine-out', 'app-1', 'engine-in')],
  })

  assert.deepEqual(contexts, {
    'engine-in': {
      sourceNodeId: 'engine-1',
      sourceHandleId: 'engine-out',
      type: 'acme.stack.engine',
      value: { host: 'tcp://10.0.0.7' },
    },
  })
})

test('stale server-resolved wiring in the node data is not what resolves', () => {
  const stale = node('app-1', 'acme.stack.app', {
    __resolvedContexts: { 'engine-in': { sourceNodeId: 'engine-2', sourceHandleId: 'engine-out' } },
  })
  const contexts = resolveInputContexts('app-1', {
    nodes: [nodes[0], nodes[1], stale],
    edges: [edge('engine-1', 'engine-out', 'app-1', 'engine-in')],
  })

  assert.equal(contexts['engine-in']?.sourceNodeId, 'engine-1')
})

test('a handle carrying two edges is fed by the first, even when the first resolves nothing', () => {
  const contexts = resolveInputContexts('app-1', {
    nodes,
    edges: [
      edge('engine-1', 'engine-out', 'app-1', 'engine-in'),
      edge('engine-2', 'engine-out', 'app-1', 'engine-in'),
      edge('engine-1', 'silent-out', 'app-1', 'spare-in'),
      edge('engine-2', 'engine-out', 'app-1', 'spare-in'),
    ],
  })

  assert.deepEqual(Object.keys(contexts), ['engine-in'])
  assert.equal(contexts['engine-in']?.sourceNodeId, 'engine-1')
})

test('an unwired node has no inputs', () => {
  assert.deepEqual(resolveInputContexts('app-1', { nodes, edges: [] }), {})
})

test('edges into other nodes, and a source that exposes nothing on its handle, contribute no input', () => {
  const contexts = resolveInputContexts('app-1', {
    nodes: [...nodes, node('app-2', 'acme.stack.app')],
    edges: [edge('engine-1', 'engine-out', 'app-2', 'engine-in'), edge('engine-2', 'silent-out', 'app-1', 'spare-in')],
  })

  assert.deepEqual(contexts, {})
})

test("an output built from its node's own input reads that input from the canvas, not from stale node data", () => {
  const relay = node('relay-1', 'acme.stack.relay', {
    __resolvedContexts: { 'engine-in': { sourceNodeId: 'engine-2', value: { host: 'tcp://10.0.0.8' } } },
  })
  const contexts = resolveInputContexts('app-1', {
    nodes: [...nodes, relay],
    edges: [edge('engine-1', 'engine-out', 'relay-1', 'engine-in'), edge('relay-1', 'relay-out', 'app-1', 'engine-in')],
  })

  assert.deepEqual(contexts, {
    'engine-in': {
      sourceNodeId: 'relay-1',
      sourceHandleId: 'relay-out',
      type: 'acme.stack.engine',
      value: { via: { host: 'tcp://10.0.0.7' } },
    },
  })
})

test("unwiring a source's own input on the canvas drops the output built from it", () => {
  const relay = node('relay-1', 'acme.stack.relay', {
    __resolvedContexts: { 'engine-in': { sourceNodeId: 'engine-1', value: { host: 'tcp://10.0.0.7' } } },
  })
  const contexts = resolveInputContexts('app-1', {
    nodes: [...nodes, relay],
    edges: [edge('relay-1', 'relay-out', 'app-1', 'engine-in')],
  })

  assert.deepEqual(contexts, {})
})

test('a wiring cycle ends the chain: a node met again upstream of itself contributes no inputs there', () => {
  const contexts = resolveInputContexts('app-1', {
    nodes: [...nodes, node('relay-1', 'acme.stack.relay'), node('relay-2', 'acme.stack.relay')],
    edges: [
      edge('relay-2', 'relay-out', 'relay-1', 'engine-in'),
      edge('relay-1', 'relay-out', 'relay-2', 'engine-in'),
      edge('relay-1', 'relay-out', 'app-1', 'engine-in'),
    ],
  })

  assert.deepEqual(contexts, {})
})

test('a source node missing from the page contributes no input', () => {
  const contexts = resolveInputContexts('app-1', {
    nodes: [nodes[2]],
    edges: [edge('engine-1', 'engine-out', 'app-1', 'engine-in')],
  })

  assert.deepEqual(contexts, {})
})
