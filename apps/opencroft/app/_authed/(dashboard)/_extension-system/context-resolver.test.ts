// A node's inputs as the open canvas has them: resolved from the page's own
// edges and source nodes, not from the `__resolvedContexts` the server writes
// into node data on save.
import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import { AWAITING_RUN_KEY, NO_ENUMS, OBJECT_TYPE, STRING_TYPE, UNRESOLVED_INPUTS_KEY } from '@opencroft/core/values'
import type { Edge, Node } from '@xyflow/react'

import {
  CALL_ACTION,
  CALL_ACTION_TYPE,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/call-action-shared'
import {
  VALUE_NODE,
  valueNodeExposed,
  valueNodeOutput,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/value-nodes-shared'
import type { ExtensionDeclaration } from '@/app/_authed/(extension-runtime)/_client/host'
import { loadedDeclaration } from '@/app/_authed/(extension-runtime)/_client/loaded-declaration'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { liveNodeData, resolveInputContexts, sameContext } from './context-resolver'

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
    {
      // A producer whose output has a value only while its run dispatches,
      // which the canvas never has: it exposes nothing there.
      type: 'route',
      name: 'Route',
      component,
      handles: [{ id: 'body', role: 'source', handleType: OBJECT_TYPE, runtime: true }],
      exposeOutput: () => undefined,
    },
  ],
}

// The core Get node as the canvas runs it: its handles follow its data
// (`declaredHandlesOf`), and its output is the value node's own.
const coreDeclaration: ExtensionDeclaration = {
  manifest: {},
  nodes: [
    {
      type: VALUE_NODE.get,
      name: 'Get',
      component,
      handles: [],
      exposeOutput: (handleId, data) =>
        valueNodeExposed(VALUE_NODE.get, handleId, data as Record<string, unknown>, NO_ENUMS),
    },
    {
      // As the core client declares it: its handles follow its data, and its
      // outcome outputs expose nothing on the canvas.
      type: CALL_ACTION,
      name: 'Call Action',
      component,
      handles: [],
      exposeOutput: () => undefined,
    },
  ],
}

beforeEach(() => {
  extensionRegistry.register(loadedDeclaration(declaration, { id: 'acme.stack', folder: 'acme.stack' }))
  extensionRegistry.register(loadedDeclaration(coreDeclaration, { id: 'builtin.core', folder: 'builtin.core' }))
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

test('contexts compare plain data by content and a live value by identity', () => {
  const context = (value: unknown) => ({
    sourceNodeId: 'engine-1',
    sourceHandleId: 'engine-out',
    type: 'engine',
    value,
  })
  const live = new Blob(['a'])

  assert.equal(sameContext(context({ hosts: ['a', { port: 1 }] }), context({ hosts: ['a', { port: 1 }] })), true)
  assert.equal(sameContext(context({ hosts: ['a', { port: 1 }] }), context({ hosts: ['a', { port: 2 }] })), false)
  assert.equal(sameContext(context({ host: 'a' }), context({ host: 'a', port: undefined })), false)
  assert.equal(sameContext(context(live), context(live)), true)
  assert.equal(sameContext(context(live), context(new Blob(['a']))), false)
  assert.equal(sameContext(null, context({})), false)
  assert.equal(sameContext(null, null), true)
})

// Get nodes reading an object: `get-1` reads `user` from what feeds it, and
// `get-2` reads `age` from `get-1`.
const getNodes = [
  node('route-1', 'acme.stack.route'),
  node('get-1', 'builtin.core.get', { valueType: OBJECT_TYPE, inputs: { path: 'user' } }),
  node('get-2', 'builtin.core.get', { valueType: 'builtin.core.number', inputs: { path: 'age' } }),
]

test('an input wired to a run-time output waits for a run', () => {
  const graph = { nodes: getNodes, edges: [edge('route-1', 'body', 'get-1', 'object')] }

  assert.deepEqual(resolveInputContexts('get-1', graph), {})
  const data = liveNodeData(getNodes[1], graph)
  assert.deepEqual(data[UNRESOLVED_INPUTS_KEY], ['object'])
  assert.deepEqual(data[AWAITING_RUN_KEY], ['object'])
})

test('an input fed through a value node that waits for a run waits for it too, and its node shows "When it runs"', () => {
  const graph = {
    nodes: getNodes,
    edges: [edge('route-1', 'body', 'get-1', 'object'), edge('get-1', 'value', 'get-2', 'object')],
  }

  const data = liveNodeData(getNodes[2], graph)
  assert.deepEqual(data[UNRESOLVED_INPUTS_KEY], ['object'])
  assert.deepEqual(data[AWAITING_RUN_KEY], ['object'])
  assert.deepEqual(valueNodeOutput(VALUE_NODE.get, 'value', data, NO_ENUMS), {
    ok: false,
    error: 'When it runs',
    awaitsRun: true,
  })
})

test("a Call Action's Result waits for a run, and so does the next call's parameter fed from it", () => {
  const callNodes = [
    node('call-1', CALL_ACTION_TYPE, { target: { nodes: ['store-1'] }, action: 'generate', params: [] }),
    node('get-name', 'builtin.core.get', { valueType: STRING_TYPE, inputs: { path: 'name' } }),
    node('call-2', CALL_ACTION_TYPE, {
      target: { nodes: ['store-1'] },
      action: 'delete',
      params: [{ name: 'name', type: STRING_TYPE }],
    }),
  ]
  const graph = {
    nodes: callNodes,
    edges: [edge('call-1', 'result', 'get-name', 'object'), edge('get-name', 'value', 'call-2', 'param-name')],
  }

  assert.deepEqual(liveNodeData(callNodes[1], graph)[AWAITING_RUN_KEY], ['object'])
  assert.deepEqual(liveNodeData(callNodes[2], graph)[AWAITING_RUN_KEY], ['param-name'])
})

test('an input fed by a source with an error of its own is unresolved and does not wait for a run', () => {
  // `get-1` has nothing to read from: its own error, with no run involved.
  const graph = { nodes: getNodes, edges: [edge('get-1', 'value', 'get-2', 'object')] }

  const data = liveNodeData(getNodes[2], graph)
  assert.deepEqual(data[UNRESOLVED_INPUTS_KEY], ['object'])
  assert.equal(AWAITING_RUN_KEY in data, false)
  const output = valueNodeOutput(VALUE_NODE.get, 'value', data, NO_ENUMS)
  assert.ok(output && !output.ok, 'Get has no value to give')
  assert.equal(output.awaitsRun, undefined)
})

test('a source node missing from the page contributes no input', () => {
  const contexts = resolveInputContexts('app-1', {
    nodes: [nodes[2]],
    edges: [edge('engine-1', 'engine-out', 'app-1', 'engine-in')],
  })

  assert.deepEqual(contexts, {})
})
