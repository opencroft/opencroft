// A target handle takes one edge unless it is declared `multiple`, reached the
// way agents reach it: the graph's actions through `app_call`, on a real
// graph, with a fixture extension whose manifest declares the handles.
//
// Pinned: connecting into an input without `multiple` replaces the edge there
// and says so; a `multiple` input keeps every edge, and getNodes shows the one
// that feeds it; a handle the manifest does not declare keeps every edge; two
// edges into one single input in one call are refused and change nothing;
// listNodeTypes shows which inputs are `multiple`.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-single-input-'))
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

const FOLDER = `local.single-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Single ${suffix}`,
    version: '0.0.0',
    nodes: [
      { type: 'engine', name: 'Engine', handles: [{ id: 'out', handleType: 'power', role: 'source' }] },
      {
        type: 'machine',
        name: 'Machine',
        handles: [
          { id: 'engine-in', handleType: 'power', role: 'target' },
          { id: 'spare-in', handleType: 'power', role: 'target', multiple: true },
        ],
      },
    ],
  }),
)
const ENGINE = qualifyType(FOLDER, 'engine')
const MACHINE = qualifyType(FOLDER, 'machine')

const registry = getSpacesRegistry()
await registry.ensureLoaded()

/** A new space whose default graph holds a machine and three engines, and no edges. */
async function machineGraph(name: string) {
  const nodes = [
    { id: 'machine', type: MACHINE },
    { id: 'e1', type: ENGINE },
    { id: 'e2', type: ENGINE },
    { id: 'e3', type: ENGINE },
  ]
  const space = await registry.create(`${name}-${suffix}`, `${name}-${suffix}`, {
    nodes: nodes.map((node, i) => ({ ...node, data: {}, position: { x: 0, y: i * 200 } })),
    edges: [],
  })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, 'the space has its default graph')
  return `${space.slug}.${graph.slug}`
}

async function call(app: string, action: string, params: Record<string, unknown>) {
  const result = await handleToolCall('app_call', { app, action, params }, { internal: true })
  const text = (result.content as { text: string }[])[0]?.text ?? ''
  assert.notEqual(result.isError, true, `${action}: ${text}`)
  return JSON.parse(text)
}

async function edgeEnds(app: string): Promise<string[]> {
  const edges = (await call(app, 'listEdges', {})) as { source: string; target: string }[]
  return edges.map((e) => `${e.source} -> ${e.target}`)
}

async function inputs(app: string): Promise<Record<string, string | null>> {
  const { found } = (await call(app, 'getNodes', { nodeIds: ['machine'] })) as {
    found: { handles: { input: Record<string, string | null> } }[]
  }
  return found[0].handles.input
}

test('connecting into an input without multiple replaces the edge there, and the answer names it', async () => {
  const app = await machineGraph('single-replace')
  const [first] = (await call(app, 'connectNodes', { edges: [{ source: 'e1/out', target: 'machine/engine-in' }] })) as {
    id: string
    replaced?: unknown
  }[]
  assert.equal(first.replaced, undefined, 'nothing was there to replace')

  const [second] = (await call(app, 'connectNodes', {
    edges: [{ source: 'e2/out', target: 'machine/engine-in' }],
  })) as { replaced?: { id: string; source: string; target: string }[] }[]
  assert.deepEqual(second.replaced, [{ id: first.id, source: 'e1/out', target: 'machine/engine-in' }])
  assert.deepEqual(await edgeEnds(app), ['e2/out -> machine/engine-in'])
  assert.equal((await inputs(app))['engine-in'], 'e2/out')
})

test('a multiple input keeps every edge, and getNodes shows the first, which feeds it', async () => {
  const app = await machineGraph('single-spare')
  await call(app, 'connectNodes', { edges: [{ source: 'e1/out', target: 'machine/spare-in' }] })
  const [second] = (await call(app, 'connectNodes', {
    edges: [{ source: 'e2/out', target: 'machine/spare-in' }],
  })) as { replaced?: unknown }[]
  assert.equal(second.replaced, undefined)
  assert.deepEqual(await edgeEnds(app), ['e1/out -> machine/spare-in', 'e2/out -> machine/spare-in'])
  assert.equal((await inputs(app))['spare-in'], 'e1/out')
})

test('a handle the manifest does not declare keeps every edge', async () => {
  const app = await machineGraph('single-undeclared')
  await call(app, 'connectNodes', { edges: [{ source: 'e1/out', target: 'machine/other-in' }] })
  const [second] = (await call(app, 'connectNodes', {
    edges: [{ source: 'e2/out', target: 'machine/other-in' }],
  })) as { replaced?: unknown }[]
  assert.equal(second.replaced, undefined)
  assert.deepEqual(await edgeEnds(app), ['e1/out -> machine/other-in', 'e2/out -> machine/other-in'])
})

test('two edges into one single input in one call are refused, and the graph is unchanged', async () => {
  const app = await machineGraph('single-batch')
  await call(app, 'connectNodes', { edges: [{ source: 'e1/out', target: 'machine/engine-in' }] })
  await assert.rejects(
    call(app, 'connectNodes', {
      edges: [
        { source: 'e2/out', target: 'machine/engine-in' },
        { source: 'e3/out', target: 'machine/engine-in' },
      ],
    }),
    { message: /machine\/engine-in is a single input/ },
  )
  assert.deepEqual(await edgeEnds(app), ['e1/out -> machine/engine-in'])

  // CONTROL: the same two edges into the multiple input are accepted.
  await call(app, 'connectNodes', {
    edges: [
      { source: 'e2/out', target: 'machine/spare-in' },
      { source: 'e3/out', target: 'machine/spare-in' },
    ],
  })
})

test('listNodeTypes shows which inputs are multiple', async () => {
  const app = await machineGraph('single-types')
  const types = (await call(app, 'listNodeTypes', { query: `Single ${suffix}` })) as {
    type: string
    handles: { input: { id: string; multiple?: true }[] }
  }[]
  const machine = types.find((t) => t.type === MACHINE)
  assert.deepEqual(machine?.handles.input, [
    { id: 'engine-in', handleType: qualifyType(FOLDER, 'power') },
    { id: 'spare-in', handleType: qualifyType(FOLDER, 'power'), multiple: true },
  ])
})

test('the core inputs that collect several edges are the ones declared multiple', async () => {
  const app = await machineGraph('single-core')
  const types = (await call(app, 'listNodeTypes', {})) as {
    type: string
    extension: string
    handles: { input: { id: string; multiple?: true }[] }
  }[]
  const core = types.filter((t) => t.extension === 'builtin.core')
  assert.ok(
    core.some((t) => t.handles.input.some((h) => h.id === 'ctx-in')),
    'the built-in types are listed, with an input that takes one edge',
  )
  const multiple = core.flatMap((t) => t.handles.input.filter((h) => h.multiple).map((h) => `${t.type}/${h.id}`)).sort()
  assert.deepEqual(multiple, [
    'builtin.core.call-action/exec-in',
    'builtin.core.log/text-in',
    'builtin.core.script-bash/exec-in',
    'builtin.core.script-node/exec-in',
    'builtin.core.script-python/exec-in',
    'builtin.core.send-message/text-in',
    'builtin.core.switch/exec-in',
    'builtin.core.text-generation/text-in',
  ])
})
