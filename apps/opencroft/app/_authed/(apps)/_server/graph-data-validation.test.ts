// A node type's data validator (`nodeDataValidators`), reached the way agents
// reach it: the graph's write actions through `app_call`, on a real graph,
// with a fixture extension whose server module declares the validators.
//
// Pinned: a write that introduces a problem is refused with it, naming the node
// and the field, and nothing is written; a problem the node already had does
// not refuse a write; every write leaves each node's current problems stored
// as its `data` errors; a read shows each node's current problems without
// storing them; and a validator that throws refuses nothing.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { loadSpaceGraphImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-data-validation-'))
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

// `gauge` refuses a label with a space in it, with a detail that also reads its
// `unit`; `brittle`'s validator throws.
const FOLDER = `local.checked-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER, 'server'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Checked ${suffix}`,
    version: '0.0.0',
    nodes: [
      { type: 'gauge', name: 'Gauge' },
      { type: 'brittle', name: 'Brittle' },
    ],
  }),
)
writeFileSync(
  join(root, 'extensions', FOLDER, 'server', 'index.ts'),
  `export const nodeDataValidators = {
  gauge: (data: { label?: unknown; unit?: unknown }) =>
    typeof data.label === 'string' && data.label.includes(' ')
      ? [
          {
            path: 'label',
            title: 'Label has a space',
            detail: \`"\${data.label}" has a space.\${data.unit ? \` It shows as "\${data.label} \${data.unit}".\` : ''}\`,
            next: 'Use dashes.',
          },
        ]
      : [],
  brittle: () => {
    throw new Error('validator bug')
  },
}
`,
)
const GAUGE = qualifyType(FOLDER, 'gauge')
const BRITTLE = qualifyType(FOLDER, 'brittle')

const VALID = `valid-${suffix}`
// Stored before any write checked it: data the validator finds a problem in.
const STORED_INVALID = `stored-invalid-${suffix}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const space = await registry.create(`data-validation-${suffix}`, `data-validation-${suffix}`, {
  nodes: [
    { id: VALID, type: GAUGE, position: { x: 0, y: 0 }, data: { label: 'fine', size: 1 } },
    { id: STORED_INVALID, type: GAUGE, position: { x: 0, y: 200 }, data: { label: 'a b', size: 1 } },
  ],
  edges: [],
})
const [graph] = registry.graphsOf(space.slug)
assert.ok(graph, 'the space has its default graph')
const address = `${space.slug}.${graph.slug}`

interface Problem {
  nodeId: string
  path: string
  title: string
  detail?: string
  next?: string
}

async function call(action: string, params: Record<string, unknown>) {
  const result = await handleToolCall('app_call', { app: address, action, params }, { internal: true })
  return { isError: result.isError === true, text: (result.content as { text: string }[])[0]?.text ?? '' }
}

async function refusedProblems(action: string, params: Record<string, unknown>): Promise<Problem[]> {
  const { isError, text } = await call(action, params)
  assert.equal(isError, true, `${action} is refused: ${text}`)
  const answer = JSON.parse(text) as { error: string; problems: Problem[] }
  assert.equal(answer.error, 'Invalid node data. Nothing was written.')
  return answer.problems
}

async function nodes(): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const loaded = await loadSpaceGraphImpl(address)
  assert.ok(loaded, `${address} loads`)
  return loaded.graph.nodes as unknown as { id: string; data: Record<string, unknown> }[]
}

async function nodeData(nodeId: string): Promise<Record<string, unknown>> {
  const node = (await nodes()).find((n) => n.id === nodeId)
  assert.ok(node, `${nodeId} is on the graph`)
  return node.data
}

function labelProblem(nodeId: string, label: string): Problem {
  return { nodeId, path: 'label', title: 'Label has a space', detail: `"${label}" has a space.`, next: 'Use dashes.' }
}

function dataErrors(data: Record<string, unknown>) {
  return readNodeErrors(data).filter((e) => e.source === 'data')
}

test('CONTROL: a write the validator finds nothing wrong with is stored', async () => {
  const { isError, text } = await call('writeNodeProperty', { nodeId: VALID, path: 'label', value: 'still-fine' })
  assert.equal(isError, false, text)
  assert.equal((await nodeData(VALID)).label, 'still-fine')
})

test('createNodes refuses a node created with invalid data, and creates none of the batch', async () => {
  const before = (await nodes()).length
  const problems = await refusedProblems('createNodes', {
    nodes: [
      { type: GAUGE, data: { label: 'ok' } },
      { type: GAUGE, data: { label: 'not ok' } },
    ],
  })
  assert.equal(problems.length, 1)
  const { nodeId, ...problem } = problems[0]
  assert.ok(nodeId, 'the refusal names the node it would have created')
  assert.deepEqual(problem, {
    path: 'label',
    title: 'Label has a space',
    detail: '"not ok" has a space.',
    next: 'Use dashes.',
  })
  assert.equal((await nodes()).length, before)
})

test('updateNodes refuses data that introduces a problem, naming the node and field, and writes nothing', async () => {
  assert.deepEqual(
    await refusedProblems('updateNodes', { updates: [{ nodeId: VALID, data: { label: 'x y', size: 2 } }] }),
    [labelProblem(VALID, 'x y')],
  )
  const data = await nodeData(VALID)
  assert.equal(data.label, 'still-fine')
  assert.equal(data.size, 1, 'the valid half of the update is not written either')
})

test('writeNodeProperty and editNodeProperty refuse a value that introduces a problem', async () => {
  assert.deepEqual(await refusedProblems('writeNodeProperty', { nodeId: VALID, path: 'label', value: 'x y' }), [
    labelProblem(VALID, 'x y'),
  ])
  assert.deepEqual(
    await refusedProblems('editNodeProperty', {
      nodeId: VALID,
      path: 'label',
      oldString: '-',
      newString: ' ',
    }),
    [labelProblem(VALID, 'still fine')],
  )
  assert.equal((await nodeData(VALID)).label, 'still-fine')
})

test('a problem the node already had does not refuse a write to another field, and is stored as its error', async () => {
  const { isError, text } = await call('writeNodeProperty', { nodeId: STORED_INVALID, path: 'size', value: 2 })
  assert.equal(isError, false, text)
  const data = await nodeData(STORED_INVALID)
  assert.equal(data.size, 2)
  assert.equal(data.label, 'a b', 'the stored invalid value is not rewritten')
  assert.deepEqual(
    dataErrors(data).map((e) => [e.path, e.title]),
    [['label', 'Label has a space']],
  )
})

test('a problem the node already had does not refuse a write to a field its detail reads', async () => {
  const set = await call('writeNodeProperty', { nodeId: STORED_INVALID, path: 'unit', value: 'kg' })
  assert.equal(set.isError, false, set.text)
  let data = await nodeData(STORED_INVALID)
  assert.equal(data.unit, 'kg')
  assert.deepEqual(
    dataErrors(data).map((e) => [e.path, e.detail]),
    [['label', '"a b" has a space. It shows as "a b kg".']],
  )

  const unset = await call('writeNodeProperty', { nodeId: STORED_INVALID, path: 'unit', unset: true })
  assert.equal(unset.isError, false, unset.text)
  data = await nodeData(STORED_INVALID)
  assert.equal(Object.hasOwn(data, 'unit'), false)
  assert.deepEqual(
    dataErrors(data).map((e) => [e.path, e.detail]),
    [['label', '"a b" has a space.']],
  )
})

test('writing one invalid value over another is refused; fixing it is stored and clears the error', async () => {
  assert.deepEqual(
    await refusedProblems('writeNodeProperty', { nodeId: STORED_INVALID, path: 'label', value: 'c d' }),
    [labelProblem(STORED_INVALID, 'c d')],
  )
  assert.equal((await nodeData(STORED_INVALID)).label, 'a b')

  const { isError, text } = await call('writeNodeProperty', { nodeId: STORED_INVALID, path: 'label', value: 'a-b' })
  assert.equal(isError, false, text)
  const data = await nodeData(STORED_INVALID)
  assert.equal(data.label, 'a-b')
  assert.deepEqual(dataErrors(data), [])
})

test('getNodes and findNodes show the problems of a graph nobody has opened or written, and store nothing', async () => {
  const unread = await registry.create(`data-validation-unread-${suffix}`, `data-validation-unread-${suffix}`, {
    nodes: [{ id: STORED_INVALID, type: GAUGE, position: { x: 0, y: 0 }, data: { label: 'a b' } }],
    edges: [],
  })
  const [unreadGraph] = registry.graphsOf(unread.slug)
  assert.ok(unreadGraph, 'the space has its default graph')
  const app = `${unread.slug}.${unreadGraph.slug}`
  const stored = async () => {
    const loaded = await loadSpaceGraphImpl(app)
    assert.ok(loaded, `${app} loads`)
    return (loaded.graph.nodes as unknown as { data: Record<string, unknown> }[])[0].data
  }
  // CONTROL: the stored node holds no `data` error, so one in a read comes from the read.
  assert.deepEqual(dataErrors(await stored()), [])

  const read = async (action: string, params: Record<string, unknown>) => {
    const result = await handleToolCall('app_call', { app, action, params }, { internal: true })
    const text = (result.content as { text: string }[])[0]?.text ?? ''
    assert.notEqual(result.isError, true, text)
    return JSON.parse(text)
  }
  const { found } = (await read('getNodes', { nodeIds: [STORED_INVALID] })) as {
    found: { data: Record<string, unknown> }[]
  }
  assert.deepEqual(
    dataErrors(found[0].data).map((e) => [e.path, e.title]),
    [['label', 'Label has a space']],
  )
  const matched = (await read('findNodes', { patterns: ['Label has a space'] })) as { id: string }[]
  assert.deepEqual(
    matched.map((m) => m.id),
    [STORED_INVALID],
  )

  assert.deepEqual(dataErrors(await stored()), [], 'the read stored nothing')
})

test('a validator that throws refuses nothing and stores no error', async () => {
  const { isError, text } = await call('createNodes', { nodes: [{ type: BRITTLE, data: { label: 'x y' } }] })
  assert.equal(isError, false, text)
  const [created] = JSON.parse(text) as { id: string }[]
  assert.deepEqual(dataErrors(await nodeData(created.id)), [])
})
