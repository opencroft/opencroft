// A node type's check (`nodeChecks`), reached the way agents reach it: the
// graph's read and write actions through `app_call`, on a real graph, with a
// fixture extension whose server module declares the checks.
//
// Pinned: a read shows each node's current findings from its data and wiring
// without storing them; a write stores them as the node's `check` errors and
// is never refused by them; connecting and disconnecting an edge clears and
// raises them; and a check that throws finds nothing.

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
const root = mkdtempSync(join(tmpdir(), 'graph-node-checks-'))
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

// `socket` finds a problem while nothing is connected to its `out` handle,
// with a detail that reads its `label`; `brittle`'s check throws.
const FOLDER = `local.wired-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER, 'server'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Wired ${suffix}`,
    version: '0.0.0',
    nodes: [
      { type: 'socket', name: 'Socket' },
      { type: 'brittle', name: 'Brittle' },
    ],
  }),
)
writeFileSync(
  join(root, 'extensions', FOLDER, 'server', 'index.ts'),
  `export const nodeChecks = {
  socket: (node: { id: string; data: { label?: string } }, edges: { source: string; sourceHandle?: string | null }[]) =>
    edges.some((e) => e.source === node.id && e.sourceHandle === 'out')
      ? []
      : [{ title: 'Nothing is plugged in', detail: \`\${node.data.label ?? 'The socket'} has no consumer.\`, next: 'Connect Out.' }],
  brittle: () => {
    throw new Error('check bug')
  },
}
`,
)
const SOCKET = qualifyType(FOLDER, 'socket')
const BRITTLE = qualifyType(FOLDER, 'brittle')

const LOOSE = `loose-${suffix}`
const CONSUMER = `consumer-${suffix}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()

/** A new space whose default graph holds `nodes` and no edges, never opened or written. */
async function graphWith(name: string, nodes: { id: string; type: string; data: Record<string, unknown> }[]) {
  const space = await registry.create(`${name}-${suffix}`, `${name}-${suffix}`, {
    nodes: nodes.map((node, i) => ({ ...node, position: { x: 0, y: i * 200 } })),
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

async function storedData(app: string, nodeId: string): Promise<Record<string, unknown>> {
  const loaded = await loadSpaceGraphImpl(app)
  assert.ok(loaded, `${app} loads`)
  const node = (loaded.graph.nodes as unknown as { id: string; data: Record<string, unknown> }[]).find(
    (n) => n.id === nodeId,
  )
  assert.ok(node, `${nodeId} is on the graph`)
  return node.data
}

async function readData(app: string, nodeId: string): Promise<Record<string, unknown>> {
  const { found } = (await call(app, 'getNodes', { nodeIds: [nodeId] })) as {
    found: { data: Record<string, unknown> }[]
  }
  assert.equal(found.length, 1, `getNodes finds ${nodeId}`)
  return found[0].data
}

function checkErrors(data: Record<string, unknown>) {
  return readNodeErrors(data)
    .filter((e) => e.source === 'check')
    .map(({ title, detail, next }) => ({ title, detail, next }))
}

const UNPLUGGED = { title: 'Nothing is plugged in', detail: 'Lamp has no consumer.', next: 'Connect Out.' }

test('getNodes and findNodes show what a check finds on a graph nobody has opened or written, and store nothing', async () => {
  const app = await graphWith('checks-unread', [{ id: LOOSE, type: SOCKET, data: { label: 'Lamp' } }])
  // CONTROL: the stored node holds no `check` error, so one in a read comes from the read.
  assert.deepEqual(checkErrors(await storedData(app, LOOSE)), [])

  assert.deepEqual(checkErrors(await readData(app, LOOSE)), [UNPLUGGED])
  const matched = (await call(app, 'findNodes', { patterns: ['Nothing is plugged in'] })) as { id: string }[]
  assert.deepEqual(
    matched.map((m) => m.id),
    [LOOSE],
  )

  assert.deepEqual(checkErrors(await storedData(app, LOOSE)), [], 'the read stored nothing')
})

test('a write is not refused by a finding, and stores it; connecting the edge clears it, disconnecting raises it', async () => {
  const app = await graphWith('checks-wired', [{ id: CONSUMER, type: BRITTLE, data: {} }])
  const [created] = (await call(app, 'createNodes', { nodes: [{ type: SOCKET, data: { label: 'Lamp' } }] })) as {
    id: string
  }[]
  assert.deepEqual(checkErrors(await storedData(app, created.id)), [UNPLUGGED])

  const edge = { source: `${created.id}/out`, target: `${CONSUMER}/in` }
  await call(app, 'connectNodes', { edges: [edge] })
  assert.deepEqual(checkErrors(await storedData(app, created.id)), [])
  assert.deepEqual(checkErrors(await readData(app, created.id)), [])

  await call(app, 'disconnectNodes', { edges: [edge] })
  assert.deepEqual(checkErrors(await storedData(app, created.id)), [UNPLUGGED])
})

test('an edge on another handle of the node does not satisfy the check', async () => {
  const app = await graphWith('checks-other-handle', [
    { id: LOOSE, type: SOCKET, data: { label: 'Lamp' } },
    { id: CONSUMER, type: BRITTLE, data: {} },
  ])
  await call(app, 'connectNodes', { edges: [{ source: `${LOOSE}/aux`, target: `${CONSUMER}/in` }] })
  assert.deepEqual(checkErrors(await storedData(app, LOOSE)), [UNPLUGGED])
})

test('a finding another source already reports on the node shows once', async () => {
  const deployed = { source: 'deploy', ...UNPLUGGED }
  const app = await graphWith('checks-once', [
    { id: LOOSE, type: SOCKET, data: { label: 'Lamp', __errors: [deployed] } },
  ])
  const errors = readNodeErrors(await readData(app, LOOSE))
  assert.deepEqual(errors, [deployed])
})

test('a check that throws finds nothing and refuses nothing', async () => {
  const app = await graphWith('checks-brittle', [])
  const [created] = (await call(app, 'createNodes', { nodes: [{ type: BRITTLE, data: {} }] })) as { id: string }[]
  assert.deepEqual(checkErrors(await storedData(app, created.id)), [])
  assert.deepEqual(checkErrors(await readData(app, created.id)), [])
})
