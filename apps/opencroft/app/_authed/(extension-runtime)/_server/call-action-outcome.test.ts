// A Call Action's outcome as run-time values, on the real database and the
// real builtin/core bundle: while Done dispatches, Result carries the action's
// result into the value nodes and on into a second call; while Failed
// dispatches, Error carries the failure's message. Done's targets still get
// the event the Call Action was given, and outside a run what the outcome
// feeds reads as awaiting one.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { AWAITING_RUN_KEY, BOOLEAN_TYPE, NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { secrets } from '@/server/secrets'
import { dispatchExecutionContext } from './exec-dispatch'
import { resolveGraphContexts } from './graph-context-resolver'
import type { GraphSnapshot } from './host'

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'call-action-outcome-'))
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

const DELETE_PARAMS = [
  { name: 'name', type: STRING_TYPE, description: 'Name of the secret to delete' },
  {
    name: 'allowUnclean',
    type: BOOLEAN_TYPE,
    description: 'Delete even while nodes still reference the name (default: false)',
  },
]

const answering = (script: string) => ({ language: 'node', script })
const handler = (side: string) =>
  answering(`function handler() { return { status: 200, body: { side: ${JSON.stringify(side)} } }; }`)

type Spec = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }

/** A new space whose default graph is `spec`, with node ids under a fresh prefix `n(...)`. */
async function spaceOf(name: string, spec: (n: (s: string) => string) => Spec) {
  const slug = `${name}-${crypto.randomUUID()}`
  const prefix = slug.slice(-8)
  const n = (s: string) => `${prefix}-${s}`
  const { nodes, edges } = spec(n)
  await registry.create(slug, slug, {
    nodes: nodes.map((node, i) => ({ position: { x: 0, y: i * 200 }, data: {}, ...node })),
    edges: edges.map((e, i) => ({ id: `${prefix}-e${i}`, ...e })),
  } as never)
  const [graph] = registry.graphsOf(slug)
  return { n, graph: () => graph.graph as unknown as GraphSnapshot }
}

const wire = (from: string, to: string) => {
  const [source, sourceHandle] = from.split('/')
  const [target, targetHandle] = to.split('/')
  return { source, sourceHandle, target, targetHandle }
}

// API Route -> Call Action `generate` on a store -> Done -> a second Call
// Action, `delete` on the same store, whose `name` is a String Format of the
// field `name` of the first call's Result (through a Get). Nothing is on the
// second call's Done, so the request is answered with its result.
function generateThenDelete(n: (s: string) => string): Spec {
  return {
    nodes: [
      { id: n('route'), type: core('api-route'), data: { path: `/${n('route')}`, methods: ['POST'] } },
      { id: n('store'), type: core('core-secrets-store') },
      {
        id: n('generate'),
        type: core('call-action'),
        data: {
          target: { nodes: [n('store')] },
          action: 'generate',
          params: GENERATE_PARAMS,
          inputs: { 'param-name': 'API_TOKEN' },
        },
      },
      { id: n('get'), type: core('get'), data: { valueType: STRING_TYPE, inputs: { path: 'name' } } },
      { id: n('format'), type: core('format'), data: { template: '{secret}' } },
      {
        id: n('delete'),
        type: core('call-action'),
        data: { target: { nodes: [n('store')] }, action: 'delete', params: DELETE_PARAMS },
      },
    ],
    edges: [
      wire(`${n('route')}/exec-out`, `${n('generate')}/exec-in`),
      wire(`${n('generate')}/exec-out`, `${n('delete')}/exec-in`),
      wire(`${n('generate')}/result`, `${n('get')}/object`),
      wire(`${n('get')}/value`, `${n('format')}/arg-secret`),
      wire(`${n('format')}/text`, `${n('delete')}/param-name`),
    ],
  }
}

const post = (n: (s: string) => string) =>
  dispatchExecutionContext({
    sourceNodeId: n('route'),
    sourceHandleId: 'exec-out',
    event: { method: 'POST', path: `/${n('route')}`, params: {}, query: {}, headers: {}, body: {} },
  }).then((s) => s.primary)

test("a request is answered by a second call fed a field of the first call's Result, through Get and String Format", async () => {
  const { n } = await spaceOf('outcome-chain', generateThenDelete)
  const answer = await post(n)
  assert.equal(answer.error, undefined)
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { deleted: 'API_TOKEN', secretKeys: [] })
  assert.deepEqual(await secrets.listKeys(n('store')), [])
})

test('while nothing runs, what the Result feeds awaits a run, and the stored graph keeps no result', async () => {
  const { n, graph } = await spaceOf('outcome-idle', generateThenDelete)
  const resolved = await resolveGraphContexts(graph())
  const data = (id: string) => (resolved.nodes.find((node) => node.id === n(id))?.data ?? {}) as Record<string, unknown>
  assert.deepEqual(data('get')[AWAITING_RUN_KEY], ['object'])
  assert.deepEqual(data('format')[AWAITING_RUN_KEY], ['arg-secret'])
  assert.deepEqual(data('delete')[AWAITING_RUN_KEY], ['param-name'])

  await post(n)
  assert.ok(!JSON.stringify(graph().nodes).includes('"status":"created"'), 'a result is stored in the graph')
})

test("a failed call's message is on Error while Failed dispatches", async () => {
  // Generate with no name fails; Failed runs a Switch on whether Error says so.
  const { n } = await spaceOf('outcome-error', (n) => ({
    nodes: [
      { id: n('route'), type: core('api-route'), data: { path: `/${n('route')}`, methods: ['POST'] } },
      { id: n('store'), type: core('core-secrets-store') },
      {
        id: n('call'),
        type: core('call-action'),
        data: { target: { nodes: [n('store')] }, action: 'generate', params: GENERATE_PARAMS },
      },
      { id: n('search'), type: core('regex-search'), data: { pattern: '^name has no value: ' } },
      { id: n('sw'), type: core('switch') },
      { id: n('named'), type: 'script', data: handler('named') },
      { id: n('other'), type: 'script', data: handler('other') },
    ],
    edges: [
      wire(`${n('route')}/exec-out`, `${n('call')}/exec-in`),
      wire(`${n('call')}/exec-error`, `${n('sw')}/exec-in`),
      wire(`${n('call')}/error`, `${n('search')}/text`),
      wire(`${n('search')}/matched`, `${n('sw')}/condition`),
      wire(`${n('sw')}/exec-true`, `${n('named')}/exec-in`),
      wire(`${n('sw')}/exec-false`, `${n('other')}/exec-in`),
    ],
  }))
  assert.deepEqual((await post(n)).body, { side: 'named' })
})

test('Done gets the event the Call Action was given, not its outcome', async () => {
  const { n } = await spaceOf('outcome-event', (n) => ({
    nodes: [
      { id: n('route'), type: core('api-route'), data: { path: `/${n('route')}`, methods: ['POST'] } },
      { id: n('store'), type: core('core-secrets-store') },
      {
        id: n('call'),
        type: core('call-action'),
        data: { target: { nodes: [n('store')] }, action: 'list', params: [] },
      },
      {
        id: n('echo'),
        type: 'script',
        data: answering('function handler(event) { return { status: 200, body: event.path }; }'),
      },
    ],
    edges: [
      wire(`${n('route')}/exec-out`, `${n('call')}/exec-in`),
      wire(`${n('call')}/exec-out`, `${n('echo')}/exec-in`),
    ],
  }))
  assert.deepEqual((await post(n)).body, `/${n('route')}`)
})
