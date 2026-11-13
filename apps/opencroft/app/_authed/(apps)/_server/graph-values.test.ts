// Plain values on a graph, reached the way agents reach them: the graph's
// actions through `app_call`, on a real graph, with a fixture extension whose
// manifest declares text, number and boolean handles.
//
// Pinned: connectNodes refuses a pair of types that does not connect, naming
// both, and accepts a number into a text input; it refuses an edge that closes
// a loop of values, naming the nodes on it, and writes nothing; a value typed
// into an input is `data.inputs.<handle>`, written by writeNodeProperty (which
// creates `inputs`) and by updateNodes (merged by handle), and a value of the
// wrong type is refused naming the input and its type; listNodeTypes shows an
// input's inline fields.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { BOOLEAN_TYPE, NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-values-'))
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

const FOLDER = `local.values-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Values ${suffix}`,
    version: '0.0.0',
    nodes: [
      {
        type: 'resize',
        name: 'Resize',
        handles: [
          { id: 'width', handleType: NUMBER_TYPE, role: 'target', default: 1024, integer: true, min: 1 },
          { id: 'name', handleType: STRING_TYPE, role: 'target' },
          { id: 'fit', handleType: STRING_TYPE, role: 'target', options: [{ value: 'cover' }, { value: 'contain' }] },
          { id: 'on', handleType: BOOLEAN_TYPE, role: 'target' },
          { id: 'size', handleType: NUMBER_TYPE, role: 'source' },
          { id: 'label', handleType: STRING_TYPE, role: 'source' },
        ],
      },
    ],
  }),
)
const RESIZE = qualifyType(FOLDER, 'resize')

const registry = getSpacesRegistry()
await registry.ensureLoaded()

/** A new space whose default graph holds three Resize nodes, and no edges. */
async function valuesGraph(name: string) {
  const space = await registry.create(`${name}-${suffix}`, `${name}-${suffix}`, {
    nodes: ['a', 'b', 'c'].map((id, i) => ({ id, type: RESIZE, data: {}, position: { x: 0, y: i * 200 } })),
    edges: [],
  })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, 'the space has its default graph')
  return `${space.slug}.${graph.slug}`
}

async function callResult(app: string, action: string, params: Record<string, unknown>) {
  const result = await handleToolCall('app_call', { app, action, params }, { internal: true })
  return { isError: result.isError === true, text: (result.content as { text: string }[])[0]?.text ?? '' }
}

async function call(app: string, action: string, params: Record<string, unknown>) {
  const { isError, text } = await callResult(app, action, params)
  assert.equal(isError, false, `${action}: ${text}`)
  return JSON.parse(text)
}

// A refusal is thrown as a tool error, or answered as one (a data refusal,
// with its problems as JSON); either way, its text.
async function refusal(app: string, action: string, params: Record<string, unknown>): Promise<string> {
  let answer: { isError: boolean; text: string }
  try {
    answer = await callResult(app, action, params)
  } catch (err) {
    return (err as Error).message
  }
  assert.equal(answer.isError, true, `${action} was accepted: ${answer.text}`)
  return answer.text
}

async function edgeEnds(app: string): Promise<string[]> {
  const edges = (await call(app, 'listEdges', {})) as { source: string; target: string }[]
  return edges.map((e) => `${e.source} -> ${e.target}`)
}

async function dataOf(app: string, nodeId: string): Promise<Record<string, unknown>> {
  const { found } = (await call(app, 'getNodes', { nodeIds: [nodeId] })) as {
    found: { data: Record<string, unknown> }[]
  }
  return found[0].data
}

test('a text output into a number input is refused, naming both types', async () => {
  const app = await valuesGraph('values-types')
  const text = await refusal(app, 'connectNodes', { edges: [{ source: 'a/label', target: 'b/width' }] })
  assert.match(text, new RegExp(`a/label carries ${STRING_TYPE} and b/width takes ${NUMBER_TYPE}`))
  assert.deepEqual(await edgeEnds(app), [])
})

test('a number widens into a text input, and equal types connect', async () => {
  const app = await valuesGraph('values-widen')
  await call(app, 'connectNodes', { edges: [{ source: 'a/size', target: 'b/name' }] })
  await call(app, 'connectNodes', { edges: [{ source: 'a/size', target: 'c/width' }] })
  assert.deepEqual(await edgeEnds(app), ['a/size -> b/name', 'a/size -> c/width'])
})

test('an edge that closes a loop of values is refused, naming the loop, and nothing is written', async () => {
  const app = await valuesGraph('values-loop')
  await call(app, 'connectNodes', {
    edges: [
      { source: 'a/size', target: 'b/width' },
      { source: 'b/size', target: 'c/width' },
    ],
  })
  const text = await refusal(app, 'connectNodes', { edges: [{ source: 'c/size', target: 'a/width' }] })
  assert.match(text, /loop of values: Resize \(c\) → Resize \(a\) → Resize \(b\) → Resize \(c\)/)
  assert.deepEqual(await edgeEnds(app), ['a/size -> b/width', 'b/size -> c/width'])
})

test('a loop closed by several edges in one call is refused as a whole', async () => {
  const app = await valuesGraph('values-loop-batch')
  await refusal(app, 'connectNodes', {
    edges: [
      { source: 'a/size', target: 'b/width' },
      { source: 'b/size', target: 'a/width' },
    ],
  })
  assert.deepEqual(await edgeEnds(app), [])
})

test('writeNodeProperty types a value into an input, creating inputs', async () => {
  const app = await valuesGraph('values-write')
  const { isError, text } = await callResult(app, 'writeNodeProperty', {
    nodeId: 'b',
    path: 'inputs.width',
    value: 640,
  })
  assert.equal(isError, false, text)
  assert.deepEqual((await dataOf(app, 'b')).inputs, { width: 640 })
  // A second input is written beside the first.
  await callResult(app, 'writeNodeProperty', { nodeId: 'b', path: 'inputs.name', value: 'cat' })
  assert.deepEqual((await dataOf(app, 'b')).inputs, { width: 640, name: 'cat' })
})

test('a typed value of the wrong type is refused, naming the input and its type', async () => {
  const app = await valuesGraph('values-refuse')
  const text = await refusal(app, 'writeNodeProperty', { nodeId: 'a', path: 'inputs.width', value: 'wide' })
  assert.deepEqual(JSON.parse(text).problems, [
    {
      nodeId: 'a',
      path: 'inputs.width',
      title: 'Must be a number',
      detail: `The input width takes a number (${NUMBER_TYPE}).`,
    },
  ])
  assert.equal((await dataOf(app, 'a')).inputs, undefined)
  assert.match(
    await refusal(app, 'writeNodeProperty', { nodeId: 'a', path: 'inputs.width', value: 0 }),
    /Must be at least 1/,
  )
  assert.match(
    await refusal(app, 'writeNodeProperty', { nodeId: 'a', path: 'inputs.fit', value: 'fill' }),
    /Must be one of: cover, contain/,
  )
  // CONTROL: a valid value of each type is written.
  await callResult(app, 'writeNodeProperty', { nodeId: 'a', path: 'inputs.on', value: true })
  assert.deepEqual((await dataOf(app, 'a')).inputs, { on: true })
})

test('updateNodes merges data.inputs by handle', async () => {
  const app = await valuesGraph('values-merge')
  await call(app, 'updateNodes', { updates: [{ nodeId: 'a', data: { inputs: { width: 640 } } }] })
  await call(app, 'updateNodes', { updates: [{ nodeId: 'a', data: { inputs: { name: 'cat' } } }] })
  assert.deepEqual((await dataOf(app, 'a')).inputs, { width: 640, name: 'cat' })
  await refusal(app, 'updateNodes', { updates: [{ nodeId: 'a', data: { inputs: { on: 'yes' } } }] })
  assert.deepEqual((await dataOf(app, 'a')).inputs, { width: 640, name: 'cat' })
})

test('listNodeTypes shows the inline fields of a value input', async () => {
  const app = await valuesGraph('values-types-list')
  const types = (await call(app, 'listNodeTypes', { query: `Values ${suffix}` })) as {
    type: string
    handles: { input: Record<string, unknown>[]; output: Record<string, unknown>[] }
  }[]
  const resize = types.find((t) => t.type === RESIZE)
  assert.deepEqual(resize?.handles.input, [
    { id: 'width', handleType: NUMBER_TYPE, default: 1024, integer: true, min: 1 },
    { id: 'name', handleType: STRING_TYPE },
    { id: 'fit', handleType: STRING_TYPE, options: [{ value: 'cover' }, { value: 'contain' }] },
    { id: 'on', handleType: BOOLEAN_TYPE },
  ])
  assert.deepEqual(resize?.handles.output, [
    { id: 'size', handleType: NUMBER_TYPE },
    { id: 'label', handleType: STRING_TYPE },
  ])
})
