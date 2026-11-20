// A node type's live terminals answered by its own extension, through the
// server module's `dynamicHandles` export, and listed with no code in the host
// for that type: in the terminal picker, in a node read's outputs (`getNodes`)
// and in `graph.listHandles`. A fixture extension declares the types. Nothing
// here runs inside a TanStack Start request, so it also shows the listing
// reaches the export with no Start context, as an extension's route does.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { createHost, listGraphHandleOwners } from './host'
import { listTerminalSourcesImpl, listTerminalSourceTargetsImpl } from './terminal-sources'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'dynamic-handles-'))
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

// Every type declares the dynamic terminal `shell-`:
// - `rack` answers one id per name in its data, from the data alone (`fromData`);
// - `remote` answers from its data asynchronously, as a host it would ask does;
// - `idle` answers none;
// - `brittle` throws;
// - `bare` has no entry.
const FOLDER = `local.shells-${suffix}`
const SHELL = {
  id: 'shell-',
  handleType: 'builtin.core.terminal-context',
  role: 'source',
  label: 'Shell',
  dynamic: true,
}
mkdirSync(join(root, 'extensions', FOLDER, 'server'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Shells ${suffix}`,
    version: '0.0.0',
    nodes: ['rack', 'remote', 'idle', 'brittle', 'bare'].map((type) => ({ type, name: type, handles: [SHELL] })),
  }),
)
writeFileSync(
  join(root, 'extensions', FOLDER, 'server', 'index.ts'),
  `type Node = { id: string; data: Record<string, any> }
export const dynamicHandles = {
  // 'other-1' is not under the prefix asked, so the host drops it.
  rack: { fromData: true, list: (node: Node, prefix: string) => [...(node.data.shells ?? []).map((s: string) => prefix + s), 'other-1'] },
  // Reads what the resolver stored in the node's data, as a Docker Application does.
  remote: { list: async (node: Node, prefix: string) => [prefix + node.data.__resolvedContexts?.host?.sourceNodeId] },
  idle: { fromData: true, list: () => [] },
  brittle: { fromData: true, list: () => { throw new Error('lister bug') } },
}
`,
)

const TERMINALS = { role: 'source', handleType: 'builtin.core.terminal-context' } as const

const registry = getSpacesRegistry()
await registry.ensureLoaded()

// One space holding one node of each fixture type, never opened or written.
async function seedSpace() {
  const slug = `dynamic-handles-${crypto.randomUUID()}`
  const id = (type: string) => `${type}-${crypto.randomUUID().slice(0, 8)}`
  const ids = { rack: id('rack'), remote: id('remote'), idle: id('idle'), brittle: id('brittle'), bare: id('bare') }
  const data: Record<keyof typeof ids, Record<string, unknown>> = {
    rack: { name: 'Rack', shells: ['a', 'b'] },
    remote: { name: 'Remote', __resolvedContexts: { host: { sourceNodeId: 'host-1' } } },
    idle: { name: 'Idle' },
    brittle: { name: 'Brittle' },
    bare: { name: 'Bare' },
  }
  await registry.create(slug, slug, {
    nodes: (Object.keys(ids) as (keyof typeof ids)[]).map((type, i) => ({
      id: ids[type],
      type: qualifyType(FOLDER, type),
      position: { x: 0, y: i * 200 },
      data: data[type],
    })),
    edges: [],
  })
  const [graph] = registry.graphsOf(slug)
  assert.ok(graph, 'the space has its default graph')
  return { slug, address: `${slug}.${graph.slug}`, ids }
}

test('the listing asks a fromData entry in its first answer and any other entry on its own', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { slug, ids } = await seedSpace()

  const owners = await listGraphHandleOwners(TERMINALS, { spaceSlug: slug })

  assert.deepEqual(
    owners.map((owner) => [owner.id, owner.dynamic]),
    [
      [ids.rack, false],
      [ids.remote, true],
      [ids.idle, false],
      [ids.brittle, false],
      [ids.bare, false],
    ],
  )
})

test('the picker lists a declared terminal its entry answers, and no node whose entry answers none', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { slug, ids } = await seedSpace()

  const sources = await listTerminalSourcesImpl(slug)

  assert.deepEqual(
    sources.map((source) => [source.ref.id, source.targets?.map((target) => target.target) ?? null]),
    [
      [ids.rack, [`${ids.rack}/shell-a`, `${ids.rack}/shell-b`]],
      [ids.remote, null],
    ],
    'rack in the first answer; remote asked on its own; idle, brittle and bare left out',
  )
  assert.deepEqual(
    (await listTerminalSourceTargetsImpl(ids.remote)).map((target) => target.target),
    [`${ids.remote}/shell-host-1`],
    'the entry read the data the resolver stored',
  )
  for (const none of [ids.idle, ids.brittle, ids.bare]) {
    assert.deepEqual(await listTerminalSourceTargetsImpl(none), [], `${none} has no terminal`)
  }
})

test('listHandles lists the live ids of every entry that answers, and none of the others', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { ids } = await seedSpace()

  const handles = await createHost('acme.shells-reader').graph.listHandles(TERMINALS)

  const mine = new Set(Object.values(ids))
  assert.deepEqual(
    handles
      .filter((handle) => mine.has(handle.nodeId))
      .map((handle) => [handle.nodeId, handle.handleId, handle.declaredId, handle.dynamic]),
    [
      [ids.rack, 'shell-a', 'shell-', true],
      [ids.rack, 'shell-b', 'shell-', true],
      [ids.remote, 'shell-host-1', 'shell-', true],
    ],
  )
})

/** Each node's output handle ids, as `getNodes` reads them. */
async function outputsOf(address: string, nodeIds: string[]): Promise<Record<string, string[]>> {
  const result = await handleToolCall(
    'app_call',
    { app: address, action: 'getNodes', params: { nodeIds } },
    { internal: true },
  )
  const text = (result.content as { text: string }[])[0]?.text ?? ''
  assert.notEqual(result.isError, true, text)
  const { found } = JSON.parse(text) as { found: { id: string; handles: { output: Record<string, string[]> } }[] }
  return Object.fromEntries(found.map((node) => [node.id, Object.keys(node.handles.output)]))
}

test("getNodes lists a Terminal Router's resolved routes as its outputs, through core's own entry", async () => {
  const slug = `dynamic-handles-router-${crypto.randomUUID()}`
  const routerId = `router-${crypto.randomUUID().slice(0, 8)}`
  await registry.create(slug, slug, {
    nodes: [
      {
        id: routerId,
        type: 'builtin.core.terminal-router',
        position: { x: 0, y: 0 },
        data: {
          routes: [
            { id: 'r1', target: 'machine-1/terminal', context: { type: 'local' } },
            // Its target did not resolve: no context, so no output.
            { id: 'r2', target: 'machine-2/terminal' },
          ],
        },
      },
    ],
    edges: [],
  })
  const [graph] = registry.graphsOf(slug)
  assert.ok(graph, 'the space has its default graph')

  assert.deepEqual(await outputsOf(`${slug}.${graph.slug}`, [routerId]), { [routerId]: ['route-r1'] })
})

test("getNodes lists each node's live terminal outputs, and none for a node whose entry answers none", async (t) => {
  t.mock.method(console, 'error', () => {})
  const { address, ids } = await seedSpace()

  const outputs = await outputsOf(address, Object.values(ids))

  assert.deepEqual(outputs, {
    [ids.rack]: ['shell-a', 'shell-b'],
    [ids.remote]: ['shell-host-1'],
    [ids.idle]: [],
    [ids.brittle]: [],
    [ids.bare]: [],
  })
})
