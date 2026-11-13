import assert from 'node:assert/strict'
import test from 'node:test'

import { NO_ENUMS } from '@opencroft/core/values'
import type { ExposeOutput } from '@opencroft/server/actions'

import { routeOutput, type TerminalRouterData } from '../_builtin/core/src/nodes/terminal-router-shared'
import { type ContextResolverDeps, resolveContexts } from './context-resolution'
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from './host'

// A three-node chain in which the middle node's output depends on its own
// input, the shape an application node's per-container terminal handle has:
//   docker --docker-out--> application --instance-terminal-*--> script
// The graph stores qualified types; the extension answering for them knows its
// own bare names, and that is what the resolver has to tell it.
const handle = (id: string, role: 'source' | 'target', handleType: string, dynamic?: boolean) => ({
  id,
  role,
  handleType,
  dynamic,
})

const DOCKER = 'acme.docker.docker'
const APPLICATION = 'acme.docker.application'
const SCRIPT = 'acme.docker.script'
const ROUTER = 'builtin.core.terminal-router'
const SERVER = 'acme.docker.server'
const ECHO = 'acme.docker.echo'
const DOCKER_CONTEXT = 'acme.docker.docker-context'
const ECHO_CONTEXT = 'acme.docker.echo-context'
const TERMINAL_CONTEXT = 'builtin.core.terminal-context'

const exposeOutput: ExposeOutput = (handleId, nodeData, type) => {
  if (type === 'terminal-router') {
    return routeOutput(handleId, nodeData as TerminalRouterData)
  }
  if (type === 'docker') {
    // The docker node's own rule: its context input, else the local machine.
    const resolved = nodeData.__resolvedContexts as Record<string, { value: unknown }> | undefined
    return resolved?.['ctx-in']?.value ?? { type: 'local' }
  }
  if (type === 'server') {
    return { type: 'ssh', host: 'remote.example' }
  }
  if (type === 'echo') {
    const resolved = nodeData.__resolvedContexts as Record<string, { value: unknown }> | undefined
    return { around: resolved?.['echo-in']?.value ?? null }
  }
  if (type === 'application') {
    const resolved = nodeData.__resolvedContexts as Record<string, { value: unknown }> | undefined
    const via = resolved?.['docker-in']?.value
    return via ? { type: 'docker-exec', via, containerId: handleId.slice('instance-terminal-'.length) } : undefined
  }
  return undefined
}

const deps: ContextResolverDeps = {
  nodeTypeToExtension: new Map([
    [
      DOCKER,
      {
        extensionId: 'acme.docker',
        handles: [handle('ctx-in', 'target', TERMINAL_CONTEXT), handle('docker-out', 'source', DOCKER_CONTEXT)],
      },
    ],
    [SERVER, { extensionId: 'acme.docker', handles: [handle('terminal', 'source', TERMINAL_CONTEXT)] }],
    [
      ECHO,
      {
        extensionId: 'acme.docker',
        handles: [handle('echo-in', 'target', ECHO_CONTEXT), handle('echo-out', 'source', ECHO_CONTEXT)],
      },
    ],
    [
      APPLICATION,
      {
        extensionId: 'acme.docker',
        handles: [
          handle('docker-in', 'target', DOCKER_CONTEXT),
          handle('instance-terminal-', 'source', TERMINAL_CONTEXT, true),
        ],
      },
    ],
    [SCRIPT, { extensionId: 'acme.docker', handles: [handle('ctx-in', 'target', TERMINAL_CONTEXT)] }],
    [ROUTER, { extensionId: 'builtin.core', handles: [handle('route-', 'source', TERMINAL_CONTEXT, true)] }],
  ]),
  exposeOutputOf: async () => exposeOutput,
  enumCasesOf: NO_ENUMS,
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
  return { nodes: [node('docker-1', DOCKER), node('app-1', APPLICATION), node('script-1', SCRIPT)], edges }
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

test('exposeOutput is told the bare type, and the resolved input names the qualified handle type', async () => {
  const told: string[] = []
  const recording: ContextResolverDeps = {
    ...deps,
    exposeOutputOf: async () => (handleId, nodeData, type, nodeId) => {
      told.push(type)
      return exposeOutput(handleId, nodeData, type, nodeId)
    },
  }
  const resolved = await resolveContexts(graph([dockerEdge, terminalEdge]), recording)
  assert.deepEqual(told, ['docker', 'application'])
  const inputs = nodeIn(resolved, 'app-1').data.__resolvedContexts as Record<string, { handleType: string }>
  assert.equal(inputs['docker-in'].handleType, DOCKER_CONTEXT)
})

test('an edge whose source never produces a value is left unresolved and the run terminates', async () => {
  const resolved = await resolveContexts(graph([terminalEdge]), deps)
  assert.equal(nodeIn(resolved, 'script-1').data.__resolvedContexts, undefined)
  assert.deepEqual(nodeIn(resolved, 'script-1').data.__unresolvedInputs, ['ctx-in'])
})

test('a resolved input is not listed as unresolved, and an unwired node lists nothing', async () => {
  const resolved = await resolveContexts(graph([dockerEdge, terminalEdge]), deps)
  assert.equal(nodeIn(resolved, 'app-1').data.__unresolvedInputs, undefined)
  assert.equal(nodeIn(resolved, 'script-1').data.__unresolvedInputs, undefined)
  assert.equal(nodeIn(resolved, 'docker-1').data.__unresolvedInputs, undefined)
})

test('stored unresolved inputs are recomputed, not carried over', async () => {
  const snapshot: GraphSnapshot = { nodes: [node('script-1', SCRIPT, { __unresolvedInputs: ['ctx-in'] })], edges: [] }
  const resolved = await resolveContexts(snapshot, deps)
  assert.equal(nodeIn(resolved, 'script-1').data.__unresolvedInputs, undefined)
})

test('previously stored contexts are recomputed, not carried over', async () => {
  const stale = {
    'ctx-in': { sourceNodeId: 'gone', sourceHandleId: 'gone', handleType: TERMINAL_CONTEXT, value: 1 },
  }
  const snapshot: GraphSnapshot = {
    nodes: [
      node('docker-1', DOCKER),
      node('app-1', APPLICATION),
      node('script-1', SCRIPT, { __resolvedContexts: stale }),
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

function sourceOf(snapshot: GraphSnapshot, nodeId: string, handleId: string): string | undefined {
  const contexts = nodeIn(snapshot, nodeId).data.__resolvedContexts as
    | Record<string, { sourceNodeId: string }>
    | undefined
  return contexts?.[handleId]?.sourceNodeId
}

test('a handle wired from two sources is fed by the first edge', async () => {
  const snapshot: GraphSnapshot = {
    nodes: [node('docker-1', DOCKER), node('docker-2', DOCKER), node('app-1', APPLICATION)],
    edges: [dockerEdge, { ...dockerEdge, id: 'edge-docker-2', source: 'docker-2' }],
  }
  const resolved = await resolveContexts(snapshot, deps)
  assert.equal(sourceOf(resolved, 'app-1', 'docker-in'), 'docker-1')
})

// Two sources for one script, one resolving in the first pass and one only
// once the application's own docker input is written:
//   router --route-r1--> script <--instance-terminal-*-- application <-- docker
function twoSourceScript(first: GraphEdgeRecord, second: GraphEdgeRecord, withDocker: boolean): GraphSnapshot {
  return {
    nodes: [
      node('router-1', ROUTER, { routes: [{ id: 'r1', target: 'server-9/terminal' }] }),
      node('docker-1', DOCKER),
      node('app-1', APPLICATION),
      node('script-1', SCRIPT),
    ],
    edges: [first, second, ...(withDocker ? [dockerEdge] : [])],
  }
}
const routeEdge: GraphEdgeRecord = {
  id: 'edge-route',
  source: 'router-1',
  sourceHandle: 'route-r1',
  target: 'script-1',
  targetHandle: 'ctx-in',
}

test('the first edge feeds the handle when a later edge resolves in a later pass', async () => {
  const resolved = await resolveContexts(twoSourceScript(routeEdge, terminalEdge, true), deps)
  assert.equal(sourceOf(resolved, 'script-1', 'ctx-in'), 'router-1')
})

test('the first edge feeds the handle when it resolves in a later pass than a later edge', async () => {
  const resolved = await resolveContexts(twoSourceScript(terminalEdge, routeEdge, true), deps)
  assert.equal(sourceOf(resolved, 'script-1', 'ctx-in'), 'app-1')
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), expectedTerminal)
})

test('a first edge that resolves nothing leaves the handle empty rather than falling back to the next', async () => {
  const resolved = await resolveContexts(twoSourceScript(terminalEdge, routeEdge, false), deps)
  assert.equal(nodeIn(resolved, 'script-1').data.__resolvedContexts, undefined)
})

// A router whose routes point at terminals in another space, feeding a script:
//   (server-9/terminal, elsewhere) ~~route r1~~> router --route-r1--> script
function routerGraph(routes: TerminalRouterData['routes']): GraphSnapshot {
  return {
    nodes: [node('router-1', ROUTER, { routes }), node('script-1', SCRIPT)],
    edges: [
      { id: 'edge-route', source: 'router-1', sourceHandle: 'route-r1', target: 'script-1', targetHandle: 'ctx-in' },
    ],
  }
}

test("a router route carries its target's current context, not the one stored with it", async () => {
  const stored = { type: 'ssh', host: 'stale.example' }
  const resolved = await resolveContexts(
    routerGraph([{ id: 'r1', target: 'server-9/terminal', context: stored }]),
    deps,
  )
  const fresh = { type: 'ssh', host: 'fresh.example' }
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), fresh)
  const routes = nodeIn(resolved, 'router-1').data.routes as NonNullable<TerminalRouterData['routes']>
  assert.deepEqual(routes[0], { id: 'r1', target: 'server-9/terminal', context: fresh })
})

test('a route whose target no longer resolves drops its context and feeds nothing', async () => {
  const resolved = await resolveContexts(
    routerGraph([{ id: 'r1', target: 'gone-1/terminal', context: { type: 'ssh', host: 'old' } }]),
    deps,
  )
  assert.equal(contextOf(resolved, 'script-1', 'ctx-in'), undefined)
  const routes = nodeIn(resolved, 'router-1').data.routes as NonNullable<TerminalRouterData['routes']>
  assert.deepEqual(routes[0], { id: 'r1', target: 'gone-1/terminal' })
})

// A docker node on a remote server, with several applications under it:
//   server --terminal--> docker --docker-out--> app-1, app-2 --instance-terminal-*--> script
const serverEdge: GraphEdgeRecord = {
  id: 'edge-server',
  source: 'server-1',
  sourceHandle: 'terminal',
  target: 'docker-1',
  targetHandle: 'ctx-in',
}
const secondAppEdge: GraphEdgeRecord = { ...dockerEdge, id: 'edge-docker-2', target: 'app-2' }

function remoteDockerGraph(edges: GraphEdgeRecord[]): GraphSnapshot {
  return {
    nodes: [
      node('server-1', SERVER),
      node('docker-1', DOCKER),
      node('app-1', APPLICATION),
      node('app-2', APPLICATION),
      node('script-1', SCRIPT),
    ],
    edges,
  }
}

const remote = { type: 'ssh', host: 'remote.example' }

test("every application under a docker node gets the docker node's input when that input's edge is stored last", async () => {
  const resolved = await resolveContexts(remoteDockerGraph([dockerEdge, secondAppEdge, terminalEdge, serverEdge]), deps)
  assert.deepEqual(contextOf(resolved, 'docker-1', 'ctx-in'), remote)
  assert.deepEqual(contextOf(resolved, 'app-1', 'docker-in'), remote)
  assert.deepEqual(contextOf(resolved, 'app-2', 'docker-in'), remote)
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), {
    type: 'docker-exec',
    via: remote,
    containerId: 'my-container',
  })
})

test("the applications get the docker node's input when its edge is stored first (control)", async () => {
  const resolved = await resolveContexts(remoteDockerGraph([serverEdge, dockerEdge, secondAppEdge, terminalEdge]), deps)
  assert.deepEqual(contextOf(resolved, 'app-1', 'docker-in'), remote)
  assert.deepEqual(contextOf(resolved, 'app-2', 'docker-in'), remote)
})

test('a source is read once when its inputs are resolved before it', async () => {
  let readsOfDocker = 0
  const counting: ContextResolverDeps = {
    ...deps,
    exposeOutputOf: async () => (handleId, nodeData, type, nodeId) => {
      readsOfDocker += type === 'docker' ? 1 : 0
      return exposeOutput(handleId, nodeData, type, nodeId)
    },
  }
  await resolveContexts(remoteDockerGraph([serverEdge, dockerEdge, secondAppEdge]), counting)
  assert.equal(readsOfDocker, 2)
})

// A docker node that falls back to the local machine only when nothing is
// wired to its input, and exposes nothing while a wired input is unresolved.
const strictDocker: ContextResolverDeps = {
  ...deps,
  exposeOutputOf: async () => (handleId, nodeData, type, nodeId) => {
    if (type === 'docker' && (nodeData.__unresolvedInputs as string[] | undefined)?.includes('ctx-in')) {
      return undefined
    }
    return exposeOutput(handleId, nodeData, type, nodeId)
  },
}

test('a source is told a wired input is unresolved at every read until it resolves', async () => {
  const resolved = await resolveContexts(
    remoteDockerGraph([dockerEdge, secondAppEdge, terminalEdge, serverEdge]),
    strictDocker,
  )
  assert.deepEqual(contextOf(resolved, 'app-1', 'docker-in'), remote)
  assert.deepEqual(contextOf(resolved, 'app-2', 'docker-in'), remote)
  assert.deepEqual(contextOf(resolved, 'script-1', 'ctx-in'), {
    type: 'docker-exec',
    via: remote,
    containerId: 'my-container',
  })
})

test('a wired input whose source is gone leaves everything under it unresolved, not local', async () => {
  const snapshot = remoteDockerGraph([dockerEdge, secondAppEdge, terminalEdge, { ...serverEdge, source: 'gone-1' }])
  const resolved = await resolveContexts(snapshot, strictDocker)
  assert.deepEqual(nodeIn(resolved, 'docker-1').data.__unresolvedInputs, ['ctx-in'])
  assert.deepEqual(nodeIn(resolved, 'app-1').data.__unresolvedInputs, ['docker-in'])
  assert.deepEqual(nodeIn(resolved, 'app-2').data.__unresolvedInputs, ['docker-in'])
  assert.equal(contextOf(resolved, 'app-1', 'docker-in'), undefined)
  assert.equal(contextOf(resolved, 'script-1', 'ctx-in'), undefined)
})

test('a cycle of contexts that never settles still ends', async () => {
  const snapshot: GraphSnapshot = {
    nodes: [node('echo-1', ECHO), node('echo-2', ECHO)],
    edges: [
      { id: 'e1', source: 'echo-1', sourceHandle: 'echo-out', target: 'echo-2', targetHandle: 'echo-in' },
      { id: 'e2', source: 'echo-2', sourceHandle: 'echo-out', target: 'echo-1', targetHandle: 'echo-in' },
    ],
  }
  const resolved = await resolveContexts(snapshot, deps)
  assert.ok(contextOf(resolved, 'echo-1', 'echo-in'))
  assert.ok(contextOf(resolved, 'echo-2', 'echo-in'))
})
