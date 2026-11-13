// The API Route's check as an agent meets it: `getNodes` through `app_call`
// on a real graph, with the built-in core's `nodeChecks`.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { API_ROUTE_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)
const ROUTE = `route-${suffix}`
const SCRIPT = `script-${suffix}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const space = await registry.create(`route-check-${suffix}`, `route-check-${suffix}`, {
  nodes: [
    { id: ROUTE, type: API_ROUTE_NODE_TYPE, position: { x: 0, y: 0 }, data: { path: `/${suffix}`, methods: ['GET'] } },
    { id: SCRIPT, type: 'builtin.core.script-bash', position: { x: 400, y: 0 }, data: { script: 'echo ok' } },
  ],
  edges: [],
})
const [graph] = registry.graphsOf(space.slug)
assert.ok(graph, 'the space has its default graph')
const app = `${space.slug}.${graph.slug}`

async function call(action: string, params: Record<string, unknown>) {
  const result = await handleToolCall('app_call', { app, action, params }, { internal: true })
  const text = (result.content as { text: string }[])[0]?.text ?? ''
  assert.notEqual(result.isError, true, `${action}: ${text}`)
  return JSON.parse(text)
}

async function routeCheckErrors() {
  const { found } = (await call('getNodes', { nodeIds: [ROUTE] })) as { found: { data: Record<string, unknown> }[] }
  return readNodeErrors(found[0].data).filter((e) => e.source === 'check')
}

test('an agent reading a route with no handler gets "No connected handler", and none once a handler is wired', async () => {
  assert.deepEqual(await routeCheckErrors(), [
    {
      source: 'check',
      title: 'No connected handler',
      detail: 'This route answers every request with 502 until something handles it.',
      next: 'Connect the Handler output to the node that should answer the request.',
    },
  ])
  await call('connectNodes', { edges: [{ source: `${ROUTE}/exec-out`, target: `${SCRIPT}/exec-in` }] })
  assert.deepEqual(await routeCheckErrors(), [])
})
