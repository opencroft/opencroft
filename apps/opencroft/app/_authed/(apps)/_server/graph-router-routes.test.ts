// A Terminal Router's routes reach terminals, never another router's route,
// reached the way agents write them: the graph's write actions through
// `app_call`, on real graphs in two spaces.
//
// Pinned: a write that adds a route to a router's route is refused with a
// message naming that route and the terminal it reaches, through
// writeNodeProperty, updateNodes and createNodes, and nothing is written; a
// route to a terminal in another space is stored; a write that leaves a route
// to a route already stored as it is goes ahead, and the router's check
// reports that route.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { TERMINAL_ROUTER_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { loadSpaceGraphImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)
const LOCAL = 'builtin.core.localhost'

// The other space: a terminal, and a router with a route to it.
const THERE_LOCAL = `there-local-${suffix}`
const THERE_ROUTER = `there-router-${suffix}`
const THERE_ROUTE = `${THERE_ROUTER}/route-a1`
// This space: an empty router, and one stored with a route to a route before
// any write checked it.
const ROUTER = `router-${suffix}`
const CHAINED = `chained-${suffix}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()
await registry.create(`router-routes-there-${suffix}`, `router-routes-there-${suffix}`, {
  nodes: [
    { id: THERE_LOCAL, type: LOCAL, position: { x: 0, y: 0 }, data: { name: 'far-machine' } },
    {
      id: THERE_ROUTER,
      type: TERMINAL_ROUTER_NODE_TYPE,
      position: { x: 0, y: 200 },
      data: { routes: [{ id: 'a1', target: `${THERE_LOCAL}/terminal`, context: { type: 'local' } }] },
    },
  ],
  edges: [],
})
const space = await registry.create(`router-routes-${suffix}`, `router-routes-${suffix}`, {
  nodes: [
    { id: ROUTER, type: TERMINAL_ROUTER_NODE_TYPE, position: { x: 0, y: 0 }, data: { routes: [] } },
    {
      id: CHAINED,
      type: TERMINAL_ROUTER_NODE_TYPE,
      position: { x: 0, y: 200 },
      data: { routes: [{ id: 'c1', target: THERE_ROUTE }] },
    },
  ],
  edges: [],
})
const [graph] = registry.graphsOf(space.slug)
assert.ok(graph, 'the space has its default graph')
const address = `${space.slug}.${graph.slug}`

// A refusal is thrown as a tool error (invalid params); read either way.
async function call(action: string, params: Record<string, unknown>) {
  try {
    const result = await handleToolCall('app_call', { app: address, action, params }, { internal: true })
    return { isError: result.isError === true, text: (result.content as { text: string }[])[0]?.text ?? '' }
  } catch (err) {
    assert.equal((err as { code?: number }).code, -32602, `refused as invalid params: ${String(err)}`)
    return { isError: true, text: (err as { message: string }).message }
  }
}

async function nodes(): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const loaded = await loadSpaceGraphImpl(address)
  assert.ok(loaded, `${address} loads`)
  return loaded.graph.nodes as unknown as { id: string; data: Record<string, unknown> }[]
}

async function routesOf(nodeId: string): Promise<unknown> {
  return (await nodes()).find((node) => node.id === nodeId)?.data.routes
}

function assertRefusedRouteToRoute({ isError, text }: { isError: boolean; text: string }) {
  assert.equal(isError, true, `refused: ${text}`)
  assert.match(text, new RegExp(`${THERE_ROUTE} is a route of the Terminal Router ${THERE_ROUTER}`))
  assert.match(text, /A route cannot point at another route/)
  assert.ok(text.includes(`${THERE_LOCAL}/terminal`), `names the terminal the route reaches: ${text}`)
}

test('CONTROL: a route to a terminal in another space is stored', async () => {
  const routes = [{ id: 'ok', target: `${THERE_LOCAL}/terminal` }]
  const { isError, text } = await call('writeNodeProperty', { nodeId: ROUTER, path: 'routes', value: routes })
  assert.equal(isError, false, text)
  assert.deepEqual(
    ((await routesOf(ROUTER)) as { target: string }[]).map((route) => route.target),
    [`${THERE_LOCAL}/terminal`],
  )
})

test('writeNodeProperty refuses a route to another router’s route, and writes nothing', async () => {
  const before = await routesOf(ROUTER)
  assertRefusedRouteToRoute(
    await call('writeNodeProperty', { nodeId: ROUTER, path: 'routes', value: [{ id: 'bad', target: THERE_ROUTE }] }),
  )
  assert.deepEqual(await routesOf(ROUTER), before)
})

test('updateNodes refuses a route to another router’s route, and writes nothing', async () => {
  const before = await routesOf(ROUTER)
  assertRefusedRouteToRoute(
    await call('updateNodes', {
      updates: [{ nodeId: ROUTER, data: { routes: [{ id: 'bad', target: THERE_ROUTE }] } }],
    }),
  )
  assert.deepEqual(await routesOf(ROUTER), before)
})

test('createNodes refuses a router created with a route to a route, and creates none of the batch', async () => {
  const count = (await nodes()).length
  assertRefusedRouteToRoute(
    await call('createNodes', {
      nodes: [
        { type: LOCAL, data: { name: 'fine' } },
        { type: TERMINAL_ROUTER_NODE_TYPE, data: { routes: [{ id: 'bad', target: THERE_ROUTE }] } },
      ],
    }),
  )
  assert.equal((await nodes()).length, count)
})

test('a write leaving a stored route to a route as it is goes ahead, and the router’s check reports that route', async () => {
  const { isError, text } = await call('writeNodeProperty', { nodeId: CHAINED, path: 'name', value: 'renamed' })
  assert.equal(isError, false, text)
  const chained = (await nodes()).find((node) => node.id === CHAINED)
  assert.equal(chained?.data.name, 'renamed')
  const findings = readNodeErrors(chained?.data ?? {}).filter((error) => error.source === 'check')
  assert.deepEqual(
    findings.map((finding) => finding.title),
    ['Route to another route'],
  )
  assert.match(findings[0].detail ?? '', new RegExp(`${THERE_ROUTE} is a route of the Terminal Router`))
})

test('the router’s check finds nothing on a router whose routes reach terminals', async () => {
  const router = (await nodes()).find((node) => node.id === ROUTER)
  assert.deepEqual(
    readNodeErrors(router?.data ?? {}).filter((error) => error.source === 'check'),
    [],
  )
})
