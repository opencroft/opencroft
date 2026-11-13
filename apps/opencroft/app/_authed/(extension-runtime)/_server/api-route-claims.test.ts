// API Route paths against the real registry, graph documents and graph
// actions: a path belongs to one route on the instance, a graph write cannot
// give a route a path another route has, and the routes sharing one carry
// errors that follow the graph.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { hostAppCall } from '@/app/_authed/(apps)/_server/host-apps'
import {
  PATH_ERROR_CODE,
  PATH_ERROR_SOURCE,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-path'
import { API_ROUTE_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { instanceRouteTable, reconcileRoutePathErrors, watchRoutePaths } from './api-route-claims'
import { matchRoute, routeTable } from './api-route-table'

const TEST_ORIGIN: GraphWriteOrigin = { kind: 'user', name: 'alice' }
const suffix = crypto.randomUUID().slice(0, 8)

const registry = getSpacesRegistry()
await registry.ensureLoaded()

let spaces = 0

/** A path no other test uses: every route of the instance shares one table. */
function pathOf(name: string): string {
  return `/${suffix}/${name}`
}

function routeNode(id: string, path: string): Record<string, unknown> {
  return { id, type: API_ROUTE_NODE_TYPE, position: { x: 0, y: 0 }, data: { path, methods: ['GET'] } }
}

/** A fresh space whose default graph holds the given nodes; answers its slug and graph address. */
async function spaceWith(nodes: Record<string, unknown>[]): Promise<{ slug: string; address: string }> {
  const slug = `route-paths-${suffix}-${spaces++}`
  const space = await registry.create(slug, slug, { nodes, edges: [] })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, `space ${slug} has its default graph`)
  return { slug: space.slug, address: `${space.slug}.${graph.slug}` }
}

async function graphAction(address: string, action: string, params: Record<string, unknown>): Promise<string> {
  const call = await hostAppCall(address, action)
  assert.ok(call, `${address} resolves as a graph app`)
  // The graph actions read only the instance id off their context.
  const ctx = { instanceId: call.instanceId } as Parameters<typeof call.action.run>[0]
  return String(await call.action.run(ctx, params))
}

function setPath(address: string, nodeId: string, path: string): Promise<void> {
  return mutateLiveGraph(address, TEST_ORIGIN, (graph) => {
    const node = (graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === nodeId)
    assert.ok(node)
    node.data = { ...node.data, path }
  })
}

function addRoute(address: string, id: string, path: string): Promise<void> {
  return mutateLiveGraph(address, TEST_ORIGIN, (graph) => {
    graph.nodes.push(routeNode(id, path))
  })
}

function pathErrorsOf(address: string, nodeId: string) {
  const ref = registry.resolveGraph(address)
  const node = (ref?.graph.graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === nodeId)
  return readNodeErrors(node?.data).filter((entry) => entry.source === PATH_ERROR_SOURCE)
}

function servedBy(requestPath: string): string {
  const match = matchRoute(instanceRouteTable(), requestPath)
  return match.kind === 'route' ? match.route.nodeId : match.kind
}

/** The check the path watcher has scheduled, if any (`api-route-claims.ts` keeps it on globalThis). */
function pendingCheck(): unknown {
  return (globalThis as unknown as { __apiRouteClaims: { timer: unknown } }).__apiRouteClaims.timer
}

/** Waits until `check` holds, for at most `ms`; answers whether it did. */
async function settles(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return true
}

test('createNodes refuses a route on a path another route of the space has, naming it', async () => {
  const { address } = await spaceWith([routeNode(`held-${suffix}`, `${pathOf('users')}/:id`)])
  await assert.rejects(
    graphAction(address, 'createNodes', {
      nodes: [{ type: API_ROUTE_NODE_TYPE, data: { path: `${pathOf('users')}/:name` } }],
    }),
    (err: { message: string }) => err.message.includes(`the API Route held-${suffix} on ${address}`),
  )
  const ref = registry.resolveGraph(address)
  assert.equal(ref?.graph.graph.nodes.length, 1, 'nothing was written')
})

test('a graph write refuses a path a route in another space has, without naming that route', async () => {
  const theirs = await spaceWith([routeNode(`theirs-${suffix}`, pathOf('shared'))])
  const mine = await spaceWith([routeNode(`mine-${suffix}`, pathOf('mine'))])
  await assert.rejects(
    graphAction(mine.address, 'writeNodeProperty', { nodeId: `mine-${suffix}`, path: 'path', value: pathOf('shared') }),
    (err: { message: string }) =>
      err.message.includes('it is the path of a route in another space.') &&
      !err.message.includes(`theirs-${suffix}`) &&
      !err.message.includes(theirs.slug),
  )
})

test('createNodes refuses two new routes sharing one path', async () => {
  const { address } = await spaceWith([])
  await assert.rejects(
    graphAction(address, 'createNodes', {
      nodes: [
        { type: API_ROUTE_NODE_TYPE, data: { path: pathOf('twice') } },
        { type: API_ROUTE_NODE_TYPE, data: { path: `${pathOf('twice')}/` } },
      ],
    }),
    { message: new RegExp(`Route Path ${pathOf('twice')} of .* is taken`) },
  )
})

test('writeNodeProperty and updateNodes refuse a taken path and accept a free one', async () => {
  const { address } = await spaceWith([routeNode(`a-${suffix}`, pathOf('a')), routeNode(`b-${suffix}`, pathOf('b'))])
  await assert.rejects(
    graphAction(address, 'writeNodeProperty', { nodeId: `b-${suffix}`, path: 'path', value: pathOf('a') }),
    { message: /is taken/ },
  )
  await assert.rejects(
    graphAction(address, 'updateNodes', { updates: [{ nodeId: `b-${suffix}`, data: { path: `${pathOf('a')}/` } }] }),
    { message: /is taken/ },
  )
  await graphAction(address, 'writeNodeProperty', { nodeId: `b-${suffix}`, path: 'path', value: pathOf('c') })
})

test('a write that leaves an existing clash as it is goes ahead', async () => {
  const { address } = await spaceWith([
    routeNode(`x-${suffix}`, pathOf('dup-x')),
    routeNode(`y-${suffix}`, pathOf('dup-x')),
  ])
  await graphAction(address, 'writeNodeProperty', { nodeId: `x-${suffix}`, path: 'methods', value: ['POST'] })
})

test('routes sharing a path nobody served hold the shared error until one of them moves', async () => {
  const { address } = await spaceWith([
    routeNode(`p-${suffix}`, pathOf('dup')),
    routeNode(`q-${suffix}`, pathOf('dup')),
  ])
  assert.equal(servedBy(pathOf('dup')), 'shared')
  await reconcileRoutePathErrors()
  const [shared] = pathErrorsOf(address, `p-${suffix}`)
  assert.equal(shared?.code, PATH_ERROR_CODE.shared)
  assert.ok(shared?.detail?.includes(`the API Route q-${suffix} on ${address}`))

  await setPath(address, `q-${suffix}`, pathOf('elsewhere'))
  await reconcileRoutePathErrors()
  assert.deepEqual(pathErrorsOf(address, `p-${suffix}`), [])
  assert.deepEqual(pathErrorsOf(address, `q-${suffix}`), [])
  assert.equal(servedBy(pathOf('dup')), `p-${suffix}`)
})

test('a route in another space taking a served path gets nothing, and the holder is known again from the stored errors', async () => {
  const old = await spaceWith([routeNode(`old-${suffix}`, pathOf('hook'))])
  assert.equal(servedBy(pathOf('hook')), `old-${suffix}`)
  const newcomer = await spaceWith([])
  await addRoute(newcomer.address, `new-${suffix}`, pathOf('hook'))
  await reconcileRoutePathErrors()
  const [held] = pathErrorsOf(old.address, `old-${suffix}`)
  assert.equal(held?.code, PATH_ERROR_CODE.held)
  assert.match(held?.detail ?? '', /a route in another space/)
  const [taken] = pathErrorsOf(newcomer.address, `new-${suffix}`)
  assert.equal(taken?.code, PATH_ERROR_CODE.taken)
  assert.doesNotMatch(taken?.detail ?? '', new RegExp(`old-${suffix}|${old.slug}`))
  assert.equal(servedBy(pathOf('hook')), `old-${suffix}`)

  // A restart forgets which route served; the stored errors still say.
  const fresh = matchRoute(
    routeTable(
      instanceRouteTable().flatMap((claim) => claim.routes),
      new Map(),
    ),
    pathOf('hook'),
  )
  assert.equal(fresh.kind === 'route' && fresh.route.nodeId, `old-${suffix}`)
})

test('a route copied onto a served path before any check or request finds the path held', async () => {
  const { address } = await spaceWith([routeNode(`served-${suffix}`, pathOf('served'))])
  await watchRoutePaths()
  await addRoute(address, `copy-${suffix}`, pathOf('served'))
  const codeOf = (nodeId: string) => pathErrorsOf(address, nodeId)[0]?.code
  assert.ok(
    await settles(() => codeOf(`copy-${suffix}`) !== undefined && codeOf(`served-${suffix}`) !== undefined),
    'the watcher gives both routes their path error',
  )
  assert.equal(codeOf(`copy-${suffix}`), PATH_ERROR_CODE.taken)
  assert.equal(codeOf(`served-${suffix}`), PATH_ERROR_CODE.held)
  assert.equal(servedBy(pathOf('served')), `served-${suffix}`)
})

test('graph changes coming faster than the check delay do not put the check off', async () => {
  await watchRoutePaths()
  assert.ok(await settles(() => pendingCheck() === undefined), 'the startup check has run')
  const { address } = await spaceWith([
    routeNode(`r-${suffix}`, pathOf('stream')),
    routeNode(`s-${suffix}`, pathOf('stream')),
  ])
  const ref = registry.resolveGraph(address)
  assert.ok(ref)
  assert.equal(pendingCheck(), undefined, 'creating the space scheduled no check')
  assert.deepEqual(pathErrorsOf(address, `r-${suffix}`), [])

  // A change every 50 ms, never pausing as long as the check delay, until the
  // routes have their errors or 5 s have passed.
  const marked = () =>
    pathErrorsOf(address, `r-${suffix}`).length > 0 && pathErrorsOf(address, `s-${suffix}`).length > 0
  const deadline = Date.now() + 5000
  while (!marked() && Date.now() < deadline) {
    registry.graphChanged(ref)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(marked(), 'the routes got their path errors while the changes went on')
  assert.equal(pathErrorsOf(address, `r-${suffix}`)[0]?.code, PATH_ERROR_CODE.shared)
})
