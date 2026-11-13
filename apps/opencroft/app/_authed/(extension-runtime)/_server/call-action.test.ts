// A Call Action on the real database and the real builtin/core extension
// bundle: an Event runs it, it calls a Secrets Store's actions with the
// parameters its inputs give, and continues on Done or Failed. Its check and
// the agents' writes are read the way agents read them, through the graph's
// actions.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'
import { db, spaceApp } from '@opencroft/db'

import { renameSpaceAppImpl } from '@/app/_authed/(apps)/_server/runtime'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { GRAPH_APP_TYPE } from '@/app/_authed/(space)/_server/types'
import { secrets } from '@/server/secrets'
import { dispatchExecutionContext } from './exec-dispatch'
import { callFromGraph, graphCallActions, graphCallTargets } from './graph-calls'
import { graphsReadingChanges } from './node-check-instance'
import { withCheckedErrors } from './node-data-validation'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'call-action-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root
after(() => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  rmSync(root, { recursive: true, force: true })
})

const registry = getSpacesRegistry()
await registry.ensureLoaded()

const core = (bare: string) => `builtin.core.${bare}`

const GENERATE_PARAMS = [
  { name: 'name', type: STRING_TYPE, required: true, description: 'Secret name to create or rotate' },
  { name: 'length', type: NUMBER_TYPE, description: 'Value length in characters (default: 32, 8-256)' },
  {
    name: 'format',
    type: STRING_TYPE,
    options: [{ value: 'alphanumeric' }, { value: 'symbols' }],
    description: 'Charset preset (default: alphanumeric)',
  },
]

const handler = (side: string) => ({
  language: 'node',
  script: `function handler() { return { status: 200, body: { side: ${JSON.stringify(side)} } }; }`,
})

type Spec = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }

/** A new space whose default graph is `spec`, with node ids under a fresh prefix `n(...)`. */
async function spaceOf(name: string, spec: (n: (s: string) => string) => Spec) {
  const slug = `${name}-${crypto.randomUUID()}`
  const prefix = slug.slice(-8)
  const n = (s: string) => `${prefix}-${s}`
  const { nodes, edges } = spec(n)
  const space = await registry.create(slug, slug, {
    nodes: nodes.map((node, i) => ({ position: { x: 0, y: i * 200 }, data: {}, ...node })),
    edges: edges.map((e, i) => ({ id: `${prefix}-e${i}`, ...e })),
  } as never)
  const [graph] = registry.graphsOf(space.slug)
  return { n, slug: space.slug, address: `${space.slug}.${graph.slug}`, instanceId: graph.instanceId }
}

const run = (n: (s: string) => string) =>
  dispatchExecutionContext({ sourceNodeId: n('event'), sourceHandleId: 'exec-out', event: {} }).then((s) => s.primary)

/** The node `id` as the graph's actions read it, with its errors. */
async function nodeAsRead(address: string, id: string) {
  const ref = registry.resolveGraph(address)
  assert.ok(ref)
  const checked = await withCheckedErrors(ref.graph.graph, { id: ref.graph.id, address })
  return checked.nodes.find((node) => (node as { id: string }).id === id) as { data: Record<string, unknown> }
}

function errorTitles(data: Record<string, unknown>, source: string): string[] {
  return readNodeErrors(data)
    .filter((e) => e.source === source)
    .map((e) => e.title)
}

// A refusal an internal call throws reads as an error result, as an agent gets it.
async function appCall(app: string, action: string, params: Record<string, unknown>) {
  try {
    const result = await handleToolCall('app_call', { app, action, params }, { internal: true })
    return { isError: result.isError === true, text: (result.content as { text: string }[])[0]?.text ?? '' }
  } catch (err) {
    const message = (err as { message?: unknown } | undefined)?.message
    return { isError: true, text: typeof message === 'string' ? message : String(err) }
  }
}

test("an Event's Run feeds a Call Action that generates a secret, and the Event answers with the action's result", async () => {
  const { n } = await spaceOf('call-generate', (n) => ({
    nodes: [
      { id: n('event'), type: core('event') },
      { id: n('store'), type: core('core-secrets-store') },
      { id: n('length'), type: core('value'), data: { valueType: 'builtin.core.number', value: 12 } },
      {
        id: n('call'),
        type: core('call-action'),
        data: {
          target: { nodes: [n('store')] },
          action: 'generate',
          params: GENERATE_PARAMS,
          inputs: { 'param-name': 'API_TOKEN', 'param-length': 64 },
        },
      },
    ],
    edges: [
      { source: n('event'), sourceHandle: 'exec-out', target: n('call'), targetHandle: 'exec-in' },
      { source: n('length'), sourceHandle: 'value', target: n('call'), targetHandle: 'param-length' },
    ],
  }))
  const answer = await run(n)
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { name: 'API_TOKEN', status: 'created' })
  assert.deepEqual(await secrets.listKeys(n('store')), ['API_TOKEN'])
  // The wired 12 won over the typed 64.
  assert.equal((await secrets.resolve('API_TOKEN', { nodeId: n('store') }))?.length, 12)
})

test('a required parameter left empty fails the call naming it, and Failed takes the run when it is wired', async () => {
  const spec = (withFailed: boolean) => (n: (s: string) => string) => ({
    nodes: [
      { id: n('event'), type: core('event') },
      { id: n('store'), type: core('core-secrets-store') },
      {
        id: n('call'),
        type: core('call-action'),
        data: {
          target: { nodes: [n('store')] },
          action: 'generate',
          params: GENERATE_PARAMS,
          inputs: { 'param-name': '' },
        },
      },
      { id: n('failed'), type: 'script', data: handler('failed') },
    ],
    edges: [
      { source: n('event'), sourceHandle: 'exec-out', target: n('call'), targetHandle: 'exec-in' },
      ...(withFailed
        ? [{ source: n('call'), sourceHandle: 'exec-error', target: n('failed'), targetHandle: 'exec-in' }]
        : []),
    ],
  })
  const unwired = await spaceOf('call-missing', spec(false))
  const answer = await run(unwired.n)
  assert.equal(answer.status, 500)
  assert.match(answer.error ?? '', /^name has no value: The action requires "name"/)
  const recorded = await nodeAsRead(unwired.address, unwired.n('call'))
  assert.deepEqual(errorTitles(recorded.data, 'action'), ['name has no value'])
  assert.deepEqual(await secrets.listKeys(unwired.n('store')), [])

  const wired = await spaceOf('call-missing-failed', spec(true))
  assert.deepEqual((await run(wired.n)).body, { side: 'failed' })
})

test('two stores are called in order, and a failure in the first stops the second', async () => {
  const { n } = await spaceOf('call-order', (n) => ({
    nodes: [
      { id: n('event'), type: core('event') },
      { id: n('a'), type: core('core-secrets-store') },
      { id: n('b'), type: core('core-secrets-store') },
      {
        id: n('both'),
        type: core('call-action'),
        data: {
          target: { nodes: [n('a'), n('b')] },
          action: 'generate',
          params: GENERATE_PARAMS,
          inputs: { 'param-name': 'K' },
        },
      },
    ],
    edges: [{ source: n('event'), sourceHandle: 'exec-out', target: n('both'), targetHandle: 'exec-in' }],
  }))
  const both = await run(n)
  assert.deepEqual(both.body, [
    { name: 'K', status: 'created' },
    { name: 'K', status: 'created' },
  ])

  // A length out of range fails at the first store; the second is never called.
  await secrets.delete(n('a'), 'K')
  await secrets.delete(n('b'), 'K')
  await assert.rejects(
    callFromGraph(n('both'), { nodes: [n('a'), n('b')] }, 'generate', { name: 'K', length: 2 }),
    (err: Error & { problem?: { title: string } }) => typeof err.problem?.title === 'string',
  )
  assert.deepEqual(await secrets.listKeys(n('b')), [])
  await callFromGraph(n('both'), { nodes: [n('b'), n('a')] }, 'generate', { name: 'K' })
  assert.deepEqual(await secrets.listKeys(n('a')), ['K'])
})

test('an app of the space is called by its identity, and a rename does not break the call', async () => {
  const space = await spaceOf('call-app', (n) => ({
    nodes: [
      { id: n('note'), type: core('markdown'), data: { title: 'Note' } },
      { id: n('call'), type: core('call-action') },
    ],
    edges: [],
  }))
  const listed = await graphCallTargets(space.n('call'))
  assert.ok(listed.apps.some((app) => app.instanceId === space.instanceId))
  assert.ok(!listed.nodes.some((node) => node.id === space.n('call')), 'the Call Action is not its own target')

  const before = await callFromGraph(space.n('call'), { app: space.instanceId }, 'listNodes', {})
  assert.match(JSON.stringify(before), new RegExp(space.n('note')))
  await renameSpaceAppImpl(space.instanceId, `Renamed ${space.slug.slice(-8)}`)
  const afterRename = await callFromGraph(space.n('call'), { app: space.instanceId }, 'listNodes', {})
  assert.match(JSON.stringify(afterRename), new RegExp(space.n('note')))
  // An action whose required parameter no value input carries is refused, naming it.
  await assert.rejects(
    callFromGraph(space.n('call'), { app: space.instanceId }, 'findNodes', {}),
    /findNodes cannot be called from a graph: Its required parameter "patterns" takes a list/,
  )
})

test('a target in another space is a check error and is refused when run', async () => {
  const other = await spaceOf('call-other', (n) => ({
    nodes: [{ id: n('store'), type: core('core-secrets-store') }],
    edges: [],
  }))
  const here = await spaceOf('call-here', (n) => ({
    nodes: [
      {
        id: n('call'),
        type: core('call-action'),
        data: { target: { nodes: [other.n('store')] }, action: 'list', params: [] },
      },
    ],
    edges: [],
  }))
  const read = await nodeAsRead(here.address, here.n('call'))
  assert.deepEqual(errorTitles(read.data, 'check'), ['Target in another space'])
  await assert.rejects(
    callFromGraph(here.n('call'), { nodes: [other.n('store')] }, 'list', {}),
    /^Error: Target in another space: /,
  )
  await assert.rejects(graphCallActions(here.n('call'), { nodes: [other.n('store')] }), /Target in another space/)
})

test('an action the target does not declare, a stale snapshot and no target are check errors', async () => {
  const { n, address } = await spaceOf('call-checks', (n) => ({
    nodes: [
      { id: n('store'), type: core('core-secrets-store') },
      { id: n('unknown'), type: core('call-action'), data: { target: { nodes: [n('store')] }, action: 'explode' } },
      {
        id: n('stale'),
        type: core('call-action'),
        data: { target: { nodes: [n('store')] }, action: 'generate', params: [] },
      },
      {
        id: n('fresh'),
        type: core('call-action'),
        data: { target: { nodes: [n('store')] }, action: 'generate', params: GENERATE_PARAMS },
      },
      { id: n('empty'), type: core('call-action') },
    ],
    edges: [],
  }))
  assert.deepEqual(errorTitles((await nodeAsRead(address, n('unknown'))).data, 'check'), ['Action not found'])
  assert.deepEqual(errorTitles((await nodeAsRead(address, n('stale'))).data, 'check'), [
    'The parameters of Generate Secret changed',
  ])
  assert.deepEqual(errorTitles((await nodeAsRead(address, n('fresh'))).data, 'check'), [])
  assert.deepEqual(errorTitles((await nodeAsRead(address, n('empty'))).data, 'check'), ['No target'])
})

test("deleting a target on another graph of the space checks the caller's graph again", async () => {
  const { n, slug, address } = await spaceOf('call-recheck', (n) => ({
    nodes: [{ id: n('call'), type: core('call-action') }],
    edges: [],
  }))
  const [row] = await db
    .insert(spaceApp)
    .values({ spaceId: registry.getBySlug(slug)?.id ?? '', type: GRAPH_APP_TYPE, name: 'Stores', slug: 'stores' })
    .returning()
  await registry.createGraph(slug, 'Stores', 'stores', row.id)
  const storesAddress = `${slug}.stores`
  const created = await appCall(storesAddress, 'createNodes', { nodes: [{ type: core('core-secrets-store') }] })
  assert.equal(created.isError, false, created.text)
  const [store] = JSON.parse(created.text) as { id: string }[]

  // The caller's check runs on this write and finds the target on the other graph.
  const written = await appCall(address, 'updateNodes', {
    updates: [{ nodeId: n('call'), data: { target: { nodes: [store.id] }, action: 'list' } }],
  })
  assert.equal(written.isError, false, written.text)
  assert.deepEqual(errorTitles((await nodeAsRead(address, n('call'))).data, 'check'), [])

  const stores = registry.resolveGraph(storesAddress)
  assert.ok(stores)
  const before = stores.graph.graph
  const deleted = await appCall(storesAddress, 'deleteNodes', { nodeIds: [store.id] })
  assert.equal(deleted.isError, false, deleted.text)
  const after = registry.resolveGraph(storesAddress)?.graph.graph
  assert.ok(after)

  // The caller's own write also checks its graph again a moment later, so
  // the error showing up afterwards would not tell the two apart: what is
  // pinned is that the deletion names the caller's graph to check again.
  const caller = registry.resolveGraph(address)
  assert.ok(caller)
  const dependents = graphsReadingChanges(stores.graph.id, before, after, { nodeIds: [store.id], edgeIds: [] })
  assert.ok(dependents.includes(caller.graph.id), `${caller.graph.id} in ${JSON.stringify(dependents)}`)
  assert.deepEqual(errorTitles((await nodeAsRead(address, n('call'))).data, 'check'), ['Target not found'])
})

test('a call that leads back to an action still running in the chain is refused as a loop', async () => {
  const { n } = await spaceOf('call-loop', (n) => ({
    nodes: [
      { id: n('event'), type: core('event') },
      {
        id: n('call'),
        type: core('call-action'),
        data: { target: { nodes: [n('event')] }, action: 'run', params: [] },
      },
    ],
    edges: [{ source: n('event'), sourceHandle: 'exec-out', target: n('call'), targetHandle: 'exec-in' }],
  }))
  const answer = await run(n)
  // The Event's Run, called again from inside its own run, reaches the Call
  // Action that is still handling the first one.
  const inner = answer.body as { status?: number; error?: string }
  assert.equal(inner.status, 500)
  assert.match(inner.error ?? '', /^Refused a loop: .* › handle is already running in this chain/)
})

test("an agent's updateNodes writing target and action gets the parameter snapshot back, and connectNodes checks a parameter's type", async () => {
  const { n, address, instanceId } = await spaceOf('call-agent', (n) => ({
    nodes: [
      { id: n('store'), type: core('core-secrets-store') },
      { id: n('call'), type: core('call-action') },
      { id: n('flag'), type: core('value'), data: { valueType: 'builtin.core.boolean', value: true } },
      { id: n('length'), type: core('value'), data: { valueType: 'builtin.core.number', value: 16 } },
    ],
    edges: [],
  }))
  const written = await appCall(address, 'updateNodes', {
    updates: [{ nodeId: n('call'), data: { target: { nodes: [n('store')] }, action: 'generate' } }],
  })
  assert.equal(written.isError, false, written.text)
  const [node] = JSON.parse(written.text) as { data: Record<string, unknown> }[]
  assert.deepEqual(node.data.params, GENERATE_PARAMS)

  const refused = await appCall(address, 'connectNodes', {
    edges: [{ source: `${n('flag')}/value`, target: `${n('call')}/param-length` }],
  })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /carries builtin\.core\.boolean and .*param-length takes builtin\.core\.number/)
  const connected = await appCall(address, 'connectNodes', {
    edges: [{ source: `${n('length')}/value`, target: `${n('call')}/param-length` }],
  })
  assert.equal(connected.isError, false, connected.text)

  // An app written by its address (the graph's own, an app of the space) is stored by its identity.
  const toApp = await appCall(address, 'updateNodes', {
    updates: [{ nodeId: n('call'), data: { target: { app: address } } }],
  })
  assert.equal(toApp.isError, false, toApp.text)
  const [appNode] = JSON.parse(toApp.text) as { data: Record<string, unknown> }[]
  assert.deepEqual(appNode.data.target, { app: instanceId })
})
