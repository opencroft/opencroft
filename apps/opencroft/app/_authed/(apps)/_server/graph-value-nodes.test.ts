// The core value nodes reached the way agents reach them: the graph's actions
// through `app_call`, on a real graph.
//
// Pinned: a value node's inputs follow its data (Math Expression's variables
// take typed numbers, refused when not); connecting a text or a boolean into a
// Switch's condition sets its type (`data.inputTypes`), kept when the edge
// goes, and a number is refused naming the types; Select's True and False
// share the type first connected into them and follow their source; nobody
// writes `data.inputTypes` by hand; Switch cases written without an id are
// given one, and its outputs follow its cases.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { BOOLEAN_TYPE, NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-value-nodes-'))
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

/** A new space whose default graph holds the given nodes, and no edges. */
async function graphOf(name: string, nodes: { id: string; type: string; data?: Record<string, unknown> }[]) {
  const space = await registry.create(`${name}-${suffix}`, `${name}-${suffix}`, {
    nodes: nodes.map((n, i) => ({ data: {}, ...n, position: { x: 0, y: i * 200 } })),
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

async function nodeOf(app: string, nodeId: string) {
  const { found } = (await call(app, 'getNodes', { nodeIds: [nodeId] })) as {
    found: {
      data: Record<string, unknown>
      handles: { input: Record<string, unknown>; output: Record<string, unknown>; types?: Record<string, string> }
    }[]
  }
  return found[0]
}

const switchNodes = [
  { id: 'text', type: core('value'), data: { valueType: 'builtin.core.string', value: 'review' } },
  { id: 'num', type: core('value'), data: { valueType: 'builtin.core.number', value: 3 } },
  { id: 'bool', type: core('value'), data: { valueType: 'builtin.core.boolean', value: true } },
  { id: 'sw', type: core('switch') },
]

test("connecting a text into a Switch's condition makes it a text Switch, kept when the edge goes, and a boolean back", async () => {
  const app = await graphOf('switch-type', switchNodes)
  const fresh = await nodeOf(app, 'sw')
  assert.deepEqual(Object.keys(fresh.handles.output), ['exec-true', 'exec-false'])
  assert.deepEqual(fresh.handles.types, { condition: BOOLEAN_TYPE })
  await call(app, 'connectNodes', { edges: [{ source: 'text/value', target: 'sw/condition' }] })
  const text = await nodeOf(app, 'sw')
  assert.deepEqual(text.data.inputTypes, { condition: STRING_TYPE })
  assert.deepEqual(text.handles.types, { condition: STRING_TYPE })
  assert.deepEqual(Object.keys(text.handles.output), ['exec-default'])
  await call(app, 'disconnectNodes', { edges: [{ source: 'text/value', target: 'sw/condition' }] })
  assert.deepEqual((await nodeOf(app, 'sw')).data.inputTypes, { condition: STRING_TYPE }, 'kept')
  await call(app, 'connectNodes', { edges: [{ source: 'bool/value', target: 'sw/condition' }] })
  assert.deepEqual((await nodeOf(app, 'sw')).data.inputTypes, { condition: BOOLEAN_TYPE })
})

test("a number into a Switch's condition is refused, naming the types it takes", async () => {
  const app = await graphOf('switch-number', switchNodes)
  const text = await refusal(app, 'connectNodes', { edges: [{ source: 'num/value', target: 'sw/condition' }] })
  assert.match(
    text,
    new RegExp(
      `num/value carries ${NUMBER_TYPE}\\. sw/condition takes true/false, a text or an enum \\(${BOOLEAN_TYPE}, ${STRING_TYPE}, every enum\\), not ${NUMBER_TYPE}`,
    ),
  )
  assert.equal((await nodeOf(app, 'sw')).data.inputTypes, undefined)
})

test('the types of inputs are set by connecting: a write of data.inputTypes is refused', async () => {
  const app = await graphOf('input-types-write', switchNodes)
  assert.match(
    await refusal(app, 'updateNodes', {
      updates: [{ nodeId: 'sw', data: { inputTypes: { condition: STRING_TYPE } } }],
    }),
    /writes data\.inputTypes: the type comes from what is connected; connect a value with connectNodes/,
  )
  assert.match(
    await refusal(app, 'writeNodeProperty', { nodeId: 'sw', path: 'inputTypes', value: { condition: STRING_TYPE } }),
    /not written by hand/,
  )
  await call(app, 'connectNodes', { edges: [{ source: 'text/value', target: 'sw/condition' }] })
  const sw = await nodeOf(app, 'sw')
  await call(app, 'updateNodes', { updates: [{ nodeId: 'sw', data: sw.data }] })
  assert.match(
    await refusal(app, 'writeNodeProperty', { nodeId: 'sw', path: 'inputTypes.condition', value: BOOLEAN_TYPE }),
    /not written by hand/,
  )
  assert.deepEqual((await nodeOf(app, 'sw')).data.inputTypes, { condition: STRING_TYPE })
})

const selectNodes = [
  { id: 'text', type: core('value'), data: { valueType: 'builtin.core.string', value: 'b' } },
  { id: 'num', type: core('value'), data: { valueType: 'builtin.core.number', value: 3 } },
  { id: 'm', type: core('math-expression'), data: { expression: 'a + 1' } },
  { id: 'sel', type: core('select') },
]

test('Select takes its type from the first value connected into True or False, and refuses another while one is wired', async () => {
  const app = await graphOf('select-type', selectNodes)
  assert.deepEqual((await nodeOf(app, 'sel')).handles.types, { true: STRING_TYPE, false: STRING_TYPE })
  await call(app, 'connectNodes', { edges: [{ source: 'num/value', target: 'sel/true' }] })
  const sel = await nodeOf(app, 'sel')
  assert.deepEqual(sel.data.inputTypes, { value: NUMBER_TYPE })
  assert.deepEqual(sel.handles.types, { true: NUMBER_TYPE, false: NUMBER_TYPE })
  assert.match(
    await refusal(app, 'connectNodes', { edges: [{ source: 'text/value', target: 'sel/false' }] }),
    new RegExp(`sel/false shares one type with the inputs of its group, and True is wired from ${NUMBER_TYPE}`),
  )
})

test('two edges of one call into one type group must carry one type', async () => {
  const app = await graphOf('select-one-call', selectNodes)
  await refusal(app, 'connectNodes', {
    edges: [
      { source: 'num/value', target: 'sel/true' },
      { source: 'text/value', target: 'sel/false' },
    ],
  })
  assert.equal((await nodeOf(app, 'sel')).data.inputTypes, undefined)
})

test("Select follows its source when the source's type changes", async () => {
  const app = await graphOf('select-follows', selectNodes)
  await call(app, 'connectNodes', { edges: [{ source: 'm/result', target: 'sel/true' }] })
  assert.deepEqual((await nodeOf(app, 'sel')).data.inputTypes, { value: NUMBER_TYPE })
  await call(app, 'updateNodes', { updates: [{ nodeId: 'm', data: { expression: 'a > 1' } }] })
  const sel = await nodeOf(app, 'sel')
  assert.deepEqual(sel.data.inputTypes, { value: BOOLEAN_TYPE })
  assert.deepEqual(sel.handles.types, { true: BOOLEAN_TYPE, false: BOOLEAN_TYPE })
})

test('Switch cases written without an id are given one, and its outputs follow them', async () => {
  const app = await graphOf('switch-cases', switchNodes)
  await call(app, 'connectNodes', { edges: [{ source: 'text/value', target: 'sw/condition' }] })
  await call(app, 'updateNodes', {
    updates: [{ nodeId: 'sw', data: { cases: [{ value: 'draft' }, { value: 'review' }] } }],
  })
  const sw = await nodeOf(app, 'sw')
  const cases = sw.data.cases as { value: string; id: string }[]
  assert.deepEqual(
    cases.map((c) => c.value),
    ['draft', 'review'],
  )
  assert.notEqual(cases[0].id, cases[1].id)
  assert.deepEqual(Object.keys(sw.handles.output), [...cases.map((c) => `case-${c.id}`), 'exec-default'])
  await refusal(app, 'updateNodes', { updates: [{ nodeId: 'sw', data: { cases: [{ value: 'a' }, { value: 'a' }] } }] })
})

test("a Math Expression's variables are its inputs, and a typed value of the wrong type is refused", async () => {
  const app = await graphOf('math-inputs', [
    { id: 'm', type: core('math-expression'), data: { expression: 'a * 2 + 1' } },
  ])
  assert.deepEqual(Object.keys((await nodeOf(app, 'm')).handles.input), ['var-a'])
  const written = await callResult(app, 'writeNodeProperty', { nodeId: 'm', path: 'inputs.var-a', value: 3 })
  assert.equal(written.isError, false, written.text)
  assert.match(
    await refusal(app, 'writeNodeProperty', { nodeId: 'm', path: 'inputs.var-a', value: 'three' }),
    /Must be a number/,
  )
  assert.deepEqual((await nodeOf(app, 'm')).data.inputs, { 'var-a': 3 })
})
