// A Server's key reached through a Terminal Router on another graph, through the real context
// resolver and the spaces registry (embedded PGlite): the routed context names the Server it came
// from, and that Server's graph is where its key is looked for.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { mutateLiveGraph, refreshGraphContexts } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { requireKeyStoreOnGraphOf } from './key-store-scope'

const KEY_STORE = 'builtin.core.core-key-store'
const SERVER = 'builtin.core.server'
const ROUTER = 'builtin.core.terminal-router'
const SCRIPT = 'builtin.core.script'
let spaces = 0

interface Route {
  id: string
  target: string
  context?: Record<string, unknown>
}

/**
 * Space A holds a Key Store and a Server whose `keyPath` names the store's key. Space B holds a
 * router whose one route points at the Server's terminal, already carrying `storedContext`, and a
 * script fed by that route.
 */
async function routedServer(storedContext?: Record<string, unknown>) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const tag = `routed-key-${crypto.randomUUID().slice(0, 8)}-${spaces++}`
  const ids = {
    storeId: `store-${tag}`,
    serverId: `server-${tag}`,
    routerId: `router-${tag}`,
    scriptId: `script-${tag}`,
  }
  const keyPath = `${ids.storeId}:deploy`
  const a = await registry.create(`${tag}-a`, `${tag}-a`, {
    nodes: [
      { id: ids.storeId, type: KEY_STORE, position: { x: 0, y: 0 }, data: {} },
      {
        id: ids.serverId,
        type: SERVER,
        position: { x: 200, y: 0 },
        data: { address: '10.0.0.7', port: 22, username: 'deploy', keyPath },
      },
    ],
    edges: [],
  })
  const route: Route = {
    id: 'r1',
    target: `${ids.serverId}/terminal`,
    ...(storedContext ? { context: storedContext } : {}),
  }
  const b = await registry.create(`${tag}-b`, `${tag}-b`, {
    nodes: [
      { id: ids.routerId, type: ROUTER, position: { x: 0, y: 0 }, data: { routes: [route] } },
      { id: ids.scriptId, type: SCRIPT, position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [],
  })
  const [graphA] = registry.graphsOf(a.slug)
  const [graphB] = registry.graphsOf(b.slug)
  return { ...ids, keyPath, addressA: `${a.slug}.${graphA.slug}`, addressB: `${b.slug}.${graphB.slug}` }
}

function nodeOn(address: string, nodeId: string): { data: Record<string, unknown> } {
  const node = getSpacesRegistry()
    .resolveGraph(address)
    ?.graph.graph.nodes.find((n) => (n as { id?: string }).id === nodeId)
  assert.ok(node, `node ${nodeId} on ${address}`)
  return node as unknown as { data: Record<string, unknown> }
}

function routeContext(address: string, routerId: string): Record<string, unknown> | undefined {
  return (nodeOn(address, routerId).data.routes as Route[])[0]?.context
}

test('a route to a Server on another graph carries that Server as its credentials scope, and its key resolves there', async () => {
  const fixture = await routedServer()
  await mutateLiveGraph(fixture.addressB, { kind: 'user', name: 'alice' }, (graph) => {
    graph.edges.push({
      id: `edge-${fixture.routerId}`,
      source: fixture.routerId,
      sourceHandle: 'route-r1',
      target: fixture.scriptId,
      targetHandle: 'ctx-in',
    })
  })

  const routed = routeContext(fixture.addressB, fixture.routerId)
  assert.equal(routed?.keyPath, fixture.keyPath)
  assert.equal(routed?.credentialsScope, fixture.serverId)
  const fed = (
    nodeOn(fixture.addressB, fixture.scriptId).data.__resolvedContexts as Record<
      string,
      { value: Record<string, unknown> }
    >
  )['ctx-in'].value
  assert.equal(fed.credentialsScope, fixture.serverId)

  await requireKeyStoreOnGraphOf(fixture.storeId, fed.credentialsScope as string)
  await assert.rejects(
    () => requireKeyStoreOnGraphOf(fixture.storeId, fixture.routerId),
    new RegExp(`No Key Store ${fixture.storeId} on graph ${fixture.addressB.replace('.', '\\.')}`),
    'the control: scoped to the router, the store is looked for on the router graph and is not there',
  )
})

test('a route context stored in an older shape is replaced by the startup refresh', async () => {
  const fixture = await routedServer({
    type: 'ssh',
    host: '10.0.0.7',
    port: 22,
    username: 'deploy',
    keyPath: '',
    passwordScope: 'gone',
  })
  const routerOnB = () => routeContext(fixture.addressB, fixture.routerId)
  assert.equal(routerOnB()?.passwordScope, 'gone', 'the control: the stored shape is what the graph holds')
  assert.equal(routerOnB()?.credentialsScope, undefined)

  await refreshGraphContexts()

  assert.equal(routerOnB()?.credentialsScope, fixture.serverId)
  assert.equal(routerOnB()?.keyPath, fixture.keyPath)
  assert.equal(routerOnB()?.passwordScope, undefined)
})
