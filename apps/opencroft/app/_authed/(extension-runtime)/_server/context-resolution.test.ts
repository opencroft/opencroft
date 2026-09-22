import assert from 'node:assert/strict'
import test from 'node:test'

import { routeOutput, type TerminalRouterData } from '../_builtin/core/src/nodes/terminal-router-shared'
import { type ContextResolverDeps, type ExposeOutput, resolveContexts } from './context-resolution'
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from './host'

// A three-node chain in which the middle node's output depends on its own
// input, the shape an application node's per-container terminal handle has:
//   docker --docker-out--> application --instance-terminal-*--> script
const handle = (id: string, role: 'source' | 'target', contextType: string, dynamic?: boolean) => ({
  id,
  role,
  contextType,
  dynamic,
})

const exposeOutput: ExposeOutput = (handleId, nodeData, typeId) => {
  if (typeId === 'terminal-router') {
    return routeOutput(handleId, nodeData as TerminalRouterData)
  }
  if (typeId === 'docker') {
    return { type: 'local' }
  }
  if (typeId === 'application') {
    const resolved = nodeData.__resolvedContexts as Record<string, { value: unknown }> | undefined
    const via = resolved?.['docker-in']?.value
    return via ? { type: 'docker-exec', via, containerId: handleId.slice('instance-terminal-'.length) } : undefined
  }
  return undefined
}

const deps: ContextResolverDeps = {
  nodeTypeToExtension: new Map([
    ['docker', { extensionId: 'my-ext', handles: [handle('docker-out', 'source', 'docker-context')] }],
    [
      'application',
      {
        extensionId: 'my-ext',
        handles: [
          handle('docker-in', 'target', 'docker-context'),
          handle('instance-terminal-', 'source', 'terminal-context', true),
        ],
      },
    ],
    ['script', { extensionId: 'my-ext', handles: [handle('ctx-in', 'target', 'terminal-context')] }],
    ['terminal-router', { extensionId: 'my-ext', handles: [handle('route-', 'source', 'terminal-context', true)] }],
  ]),
  exposeOutputOf: async () => exposeOutput,
  // Terminals living outside the resolved graph, as terminal.getContext sees them.
  resolveTerminalTarget: async (target) => {
    const live: Record<string, unknown> = { 'server-9/terminal': { type: 'ssh', host: 'fresh.example' } }
    if (!(target in live)) {
      throw new Error(`No context value for ${target}`)
    }
    return live[target]
  },
}

const node = (id: string, type: string, data: Record<string, unknown> = {}): GraphNodeRecord => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
})

const dockerEdge: GraphEdgeRecord = {
  id: 'edge-docker',
  source: 'docker-1',
  sourceHandle: 'docker-out',
  target: 'app-1',
  targetHandle: 'docker-in',
}
const terminalEdge: GraphEdgeRecord = {
  id: 'edge-terminal',
  source: 'app-1',
  sourceHandle: 'instance-terminal-my-container',
  target: 'script-1',
  targetHandle: 'ctx-in',
}

function graph(edges: GraphEdgeRecord[]): GraphSnapshot {
  return { nodes: [node('docker-1', 'docker'), node('app-1', 'application'), node('script-1', 'script')], edges }
}

function nodeIn(snapshot: GraphSnapshot, nodeId: string): GraphNodeRecord {
  const found = snapshot.nodes.find((n) => n.id === nodeId)
  assert.ok(found, `node ${nodeId} missing from the resolved graph`)
  return found
}

function contextOf(snapshot: GraphSnapshot, nodeId: string, handleId: string): unknown {
  const contexts = nodeIn(snapshot, nodeId).data.__resolvedContexts as Record<string, { value: unknown }> | undefined
  return contexts?.[handleId]?.value
}

const expectedTerminal = { type: 'docker-exec', via: { type: 'local' }, containerId: 'my-container' }

test('resolves the dependent edge when it is stored before the edge it depends on', async () => {
  const resolved = await resolveContexts(graph([terminalEdge, dockerEdge]), deps)
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), expectedTerminal)
})

test('resolves the same chain in dependency order (control)', async () => {
  const resolved = await resolveContexts(graph([dockerEdge, terminalEdge]), deps)
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), expectedTerminal)
  assert.deepEqual(contextOf(resolved, 'app-1', 'docker-in'), { type: 'local' })
})

test('an edge whose source never produces a value is left unresolved and the run terminates', async () => {
  const resolved = await resolveContexts(graph([terminalEdge]), deps)
  assert.equal(nodeIn(resolved, 'script-1').data.__resolvedContexts, undefined)
})

test('previously stored contexts are recomputed, not carried over', async () => {
  const stale = {
    'ctx-in': { sourceNodeId: 'gone', sourceHandleId: 'gone', contextType: 'terminal-context', value: 1 },
  }
  const snapshot: GraphSnapshot = {
    nodes: [
      node('docker-1', 'docker'),
      node('app-1', 'application'),
      node('script-1', 'script', { __resolvedContexts: stale }),
    ],
    edges: [],
  }
  const resolved = await resolveContexts(snapshot, deps)
  assert.equal(nodeIn(resolved, 'script-1').data.__resolvedContexts, undefined)
})

test('node order and the rest of each node are preserved', async () => {
  const resolved = await resolveContexts(graph([terminalEdge, dockerEdge]), deps)
  assert.deepEqual(
    resolved.nodes.map((n) => n.id),
    ['docker-1', 'app-1', 'script-1'],
  )
  assert.deepEqual(nodeIn(resolved, 'app-1').position, { x: 0, y: 0 })
})

// A router whose routes point at terminals in another space, feeding a script:
//   (server-9/terminal, elsewhere) ~~route r1~~> router --route-r1--> script
function routerGraph(routes: TerminalRouterData['routes']): GraphSnapshot {
  return {
    nodes: [node('router-1', 'terminal-router', { routes }), node('script-1', 'script')],
    edges: [
      { id: 'edge-route', source: 'router-1', sourceHandle: 'route-r1', target: 'script-1', targetHandle: 'ctx-in' },
    ],
  }
}

test("a router route carries its target's current context, not the one stored with it", async () => {
  const stored = { type: 'ssh', host: 'stale.example' }
  const resolved = await resolveContexts(
    routerGraph([{ id: 'r1', target: 'server-9/terminal', title: 'Server', context: stored }]),
    deps,
  )
  const fresh = { type: 'ssh', host: 'fresh.example' }
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), fresh)
  const routes = nodeIn(resolved, 'router-1').data.routes as NonNullable<TerminalRouterData['routes']>
  assert.deepEqual(routes[0], { id: 'r1', target: 'server-9/terminal', title: 'Server', context: fresh })
})

test('a route whose target no longer resolves drops its context and feeds nothing', async () => {
  const resolved = await resolveContexts(
    routerGraph([{ id: 'r1', target: 'gone-1/terminal', title: 'Gone', context: { type: 'ssh', host: 'old' } }]),
    deps,
  )
  assert.equal(contextOf(resolved, 'script-1', 'ctx-in'), undefined)
  const routes = nodeIn(resolved, 'router-1').data.routes as NonNullable<TerminalRouterData['routes']>
  assert.deepEqual(routes[0], { id: 'r1', target: 'gone-1/terminal', title: 'Gone' })
})
