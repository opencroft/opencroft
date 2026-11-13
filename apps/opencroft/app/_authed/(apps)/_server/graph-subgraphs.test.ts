// Subgraphs as agents reach them: the graph's actions through `app_call`, on a
// real graph. A node is put inside a subgraph with `parentId` and placed on its
// canvas; reads carry `subgraph` and narrow to one level; an edge between
// levels is refused naming the port route, and goes through a port instead;
// writing `data.ports` removes a port's edges with it; deleting a subgraph
// deletes what it holds.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { STRING_TYPE } from '@opencroft/core/values'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-subgraphs-'))
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

async function emptyGraph(name: string): Promise<string> {
  const space = await registry.create(`${name}-${suffix}`, `${name}-${suffix}`, { nodes: [], edges: [] })
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

/** The refusal's message: an internal call throws it, as `{ code, message }`. */
async function refused(app: string, action: string, params: Record<string, unknown>): Promise<string> {
  try {
    await call(app, action, params)
  } catch (err) {
    return String((err as { message?: unknown }).message)
  }
  assert.fail(`${action} was not refused`)
}

const TEXT = 'builtin.core.text-stream'

test('agents place, read, wire and delete nodes inside a subgraph', async () => {
  const app = await emptyGraph('subgraphs')
  const [sub, prompt] = await call(app, 'createNodes', {
    nodes: [
      {
        type: SUBGRAPH_TYPE,
        position: { x: 300, y: 100 },
        data: { name: 'Inner', ports: { inputs: [{ id: 'text', label: 'Text', handleType: TEXT }], outputs: [] } },
      },
      { type: 'builtin.core.prompt', position: { x: -500, y: 400 } },
    ],
  })
  const [log] = await call(app, 'createNodes', {
    nodes: [{ type: 'builtin.core.log', parentId: sub.id, position: { x: -40, y: 60 } }],
  })
  assert.equal(log.parentId, sub.id)
  assert.equal(log.subgraph, sub.id)
  assert.deepEqual(log.position, { x: -40, y: 60 }, 'on the subgraph’s own canvas')

  // Reads: every level, or one.
  const all = await call(app, 'listNodes', {})
  assert.deepEqual(
    all.map((n: { id: string; subgraph?: string }) => [n.id, n.subgraph]),
    [
      [sub.id, undefined],
      [prompt.id, undefined],
      [log.id, sub.id],
    ],
  )
  assert.deepEqual(
    (await call(app, 'listNodes', { subgraph: sub.id })).map((n: { id: string }) => n.id),
    [log.id],
  )
  assert.deepEqual(
    (await call(app, 'listNodes', { subgraph: null })).map((n: { id: string }) => n.id),
    [sub.id, prompt.id],
  )
  const [found] = await call(app, 'findNodes', { patterns: ['Log'] })
  assert.equal(found.subgraph, sub.id)
  assert.deepEqual(found.position, { x: -40, y: 60 })

  // An edge between levels is refused, naming the route through a port.
  const crossing = await refused(app, 'connectNodes', {
    edges: [{ source: `${prompt.id}/text-out`, target: `${log.id}/text-in` }],
  })
  assert.match(crossing, /an edge stays on one level/)
  assert.match(crossing, /<subgraph>\/in-<port>/)
  assert.match(
    await refused(app, 'connectNodes', { edges: [{ source: `${prompt.id}/text-out`, target: `${sub.id}/in-nope` }] }),
    /not a port of subgraph/,
  )

  // Through the port: outside into it, inside out of it.
  await call(app, 'connectNodes', {
    edges: [
      { source: `${prompt.id}/text-out`, target: `${sub.id}/in-text` },
      { source: `${sub.id}/in-text`, target: `${log.id}/text-in` },
    ],
  })
  const { found: read } = await call(app, 'getNodes', { nodeIds: [log.id, sub.id] })
  assert.equal(read[0].handles.input['text-in'], `${sub.id}/in-text`, 'the stored edge, not the joined one')
  assert.equal(read[1].handles.input['in-text'], `${prompt.id}/text-out`)
  assert.deepEqual(
    read[1].data.ports.inputs.map((p: { id: string }) => p.id),
    ['text'],
  )

  // Ports are written as data; malformed ones are refused, a removed one takes its edges.
  assert.match(
    await refused(app, 'updateNodes', {
      updates: [
        { nodeId: sub.id, data: { ports: { inputs: [{ id: 'a/b', label: 'x', handleType: TEXT }], outputs: [] } } },
      ],
    }),
    /data\.ports\.inputs\[0\]\.id must be letters, digits/,
  )
  await call(app, 'updateNodes', { updates: [{ nodeId: sub.id, data: { ports: { inputs: [], outputs: [] } } }] })
  assert.deepEqual(await call(app, 'listEdges', {}), [])

  // A deleted subgraph takes what it holds.
  const deleted = await call(app, 'deleteNodes', { nodeIds: [sub.id] })
  assert.deepEqual([...deleted.deleted].sort(), [sub.id, log.id].sort())
  assert.deepEqual(
    (await call(app, 'listNodes', {})).map((n: { id: string }) => n.id),
    [prompt.id],
  )
})

test('agents pass an input straight through to an output, and give a text input port choices', async () => {
  const app = await emptyGraph('through')
  const text = { id: 'text', label: 'Text', handleType: TEXT }
  const size = { id: 'size', label: 'Size', handleType: STRING_TYPE, options: [{ value: 'small' }, { value: 'large' }] }
  const [prompt, log, sub] = await call(app, 'createNodes', {
    nodes: [
      { type: 'builtin.core.prompt', position: { x: -500, y: 0 } },
      { type: 'builtin.core.log', position: { x: 500, y: 0 } },
      {
        type: SUBGRAPH_TYPE,
        position: { x: 0, y: 0 },
        data: { name: 'Through', ports: { inputs: [text, size], outputs: [{ ...text, id: 'out' }] } },
      },
    ],
  })
  await call(app, 'connectNodes', {
    edges: [
      { source: `${prompt.id}/text-out`, target: `${sub.id}/in-text` },
      { source: `${sub.id}/in-text`, target: `${sub.id}/out-out` },
      { source: `${sub.id}/out-out`, target: `${log.id}/text-in` },
    ],
  })
  // A later write runs the normaliser again; the edge through stays.
  await call(app, 'updateNodes', { updates: [{ nodeId: sub.id, data: { name: 'Still through' } }] })
  const through = (await call(app, 'listEdges', {})).filter(
    (e: { source: string; target: string }) => e.source === `${sub.id}/in-text` && e.target === `${sub.id}/out-out`,
  )
  assert.equal(through.length, 1)

  // Choices: a value outside them is refused, naming them; one of them is kept.
  assert.match(
    await refused(app, 'updateNodes', { updates: [{ nodeId: sub.id, data: { inputs: { 'in-size': 'medium' } } }] }),
    /one of: small, large/,
  )
  await call(app, 'updateNodes', { updates: [{ nodeId: sub.id, data: { inputs: { 'in-size': 'large' } } }] })
  assert.match(
    await refused(app, 'updateNodes', {
      updates: [{ nodeId: sub.id, data: { ports: { inputs: [{ ...text, options: [{ value: 'a' }] }], outputs: [] } } }],
    }),
    /options are a text input port's choices/,
  )
})

test('agents make a subgraph of wired nodes and expand it back into a Section', async () => {
  const app = await emptyGraph('make-expand')
  const [prompt, log] = await call(app, 'createNodes', {
    nodes: [
      { type: 'builtin.core.prompt', position: { x: -500, y: 400 } },
      { type: 'builtin.core.log', position: { x: 300, y: 380 } },
    ],
  })
  const [wire] = await call(app, 'connectNodes', {
    edges: [{ source: `${prompt.id}/text-out`, target: `${log.id}/text-in` }],
  })

  const made = await call(app, 'makeSubgraph', { nodeIds: [log.id], name: 'Box' })
  assert.deepEqual(
    made.ports.inputs.map((p: { handleType: string }) => p.handleType),
    [TEXT],
  )
  assert.deepEqual(made.ports.outputs, [])
  const [inLog] = await call(app, 'getNodes', { nodeIds: [log.id] }).then((r) => r.found)
  assert.equal(inLog.subgraph, made.id, 'the node is inside, under its own id')
  const port = `in-${made.ports.inputs[0].id}`
  const stored = (await call(app, 'listEdges', {})) as { id: string; source: string; target: string }[]
  assert.deepEqual(
    stored.map((e) => [e.source, e.target]).sort(),
    [
      [`${prompt.id}/text-out`, `${made.id}/${port}`],
      [`${made.id}/${port}`, `${log.id}/text-in`],
    ].sort(),
  )
  assert.ok(
    stored.some((e) => e.id === wire.id && e.target === `${log.id}/text-in`),
    'the wire keeps its id inside',
  )
  assert.match(await refused(app, 'makeSubgraph', { nodeIds: [log.id, prompt.id] }), /one level/)

  await call(app, 'expandSubgraph', { nodeId: made.id })
  const [section] = await call(app, 'getNodes', { nodeIds: [made.id] }).then((r) => r.found)
  assert.equal(section.type, 'builtin.core.section')
  assert.equal(section.data.label, 'Box')
  const [member] = await call(app, 'getNodes', { nodeIds: [log.id] }).then((r) => r.found)
  assert.deepEqual([member.parentId, member.subgraph, member.position], [made.id, undefined, { x: 300, y: 380 }])
  assert.deepEqual(
    ((await call(app, 'listEdges', {})) as { id: string; source: string; target: string }[]).map((e) => [
      e.id,
      e.source,
      e.target,
    ]),
    [[wire.id, `${prompt.id}/text-out`, `${log.id}/text-in`]],
  )
  assert.match(await refused(app, 'expandSubgraph', { nodeId: log.id }), /is not a subgraph/)
})
