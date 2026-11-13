// The Graph App's actions, reached the way every caller reaches them: through
// `app_call` on a graph's address, via the same `handleToolCall` both tool
// surfaces use.
//
// Three properties are pinned, each against two real spaces:
//   - ADDRESS ISOLATION. With no default space left, an action touches the graph
//     it was called on and nothing else — a write lands there, a read returns
//     only that graph, and a node that exists only in another space is not found.
//   - THE READ-ONLY CLASSIFICATION of an `app_call` is decided on the server from
//     the RESOLVED app, never from the action name: an extension App that
//     declares the same action — even an App the extension named `graph` —
//     is not read-only, and neither is anything that does not resolve.
//   - THE APPROVAL GATE follows each action's own declaration: a graph read is
//     not asked about, a graph write is, in the graph's space and with its view.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { db, spaceApp } from '@opencroft/db'

import { hostAppCall } from '@/app/_authed/(apps)/_server/host-apps'
import { listAppCatalog } from '@/app/_authed/(apps)/_server/runtime'
import { parseType, qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { isYoloMode } from '@/app/_authed/(mcp)/_server/yolo'
import { loadSpaceGraphImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { approvalStore } from '@/lib/approval-store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall, isReadOnlyToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A fixture extension providing an App NAMED `graph`, declaring `listNodes` —
// the strongest lookalike there is: same type name, same action id, different
// provider. Written into a scratch data dir that the extension root follows, so
// nothing installed on the machine running this joins the population.
const root = mkdtempSync(join(tmpdir(), 'graph-actions-'))
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

const LOOKALIKE_EXTENSION = `lookalike-${suffix}`
const LOOKALIKE_FOLDER = `local.${LOOKALIKE_EXTENSION}`
mkdirSync(join(root, 'extensions', LOOKALIKE_FOLDER), { recursive: true })
writeFileSync(
  join(root, 'extensions', LOOKALIKE_FOLDER, 'extension.json'),
  JSON.stringify({
    id: LOOKALIKE_FOLDER,
    name: 'Graph lookalike',
    version: '0.0.0',
    provides: { apps: [{ type: 'graph', title: 'Not the graph', actions: [{ id: 'listNodes' }] }] },
  }),
)

// A fixture extension declaring a frame (palette category Organization) and a plain node, so a
// created node's layout can be told apart by what its extension declares. The plain node
// carries a description and handles for listNodeTypes to show.
const FRAMES_FOLDER = `local.frames-${suffix}`
const FRAMES_NAME = `Frames ${suffix}`
mkdirSync(join(root, 'extensions', FRAMES_FOLDER), { recursive: true })
writeFileSync(
  join(root, 'extensions', FRAMES_FOLDER, 'extension.json'),
  JSON.stringify({
    id: FRAMES_FOLDER,
    name: FRAMES_NAME,
    version: '0.0.0',
    nodes: [
      { type: 'zone', name: 'Zone', category: 'Organization' },
      {
        type: 'gadget',
        name: 'Gadget',
        category: 'Applications',
        description: 'A gadget for the tests.',
        handles: [
          { id: 'text-in', handleType: 'builtin.core.text-stream', role: 'target', label: 'Text' },
          { id: 'route-', handleType: 'builtin.core.terminal-context', role: 'source', dynamic: true },
        ],
      },
    ],
  }),
)
const GADGET = qualifyType(FRAMES_FOLDER, 'gadget')
// Its client bundle as a build leaves it, where the gadget declares the data a
// new one starts with and the zone declares none.
const GADGET_DEFAULTS = { text: '', level: 1, tags: ['new'] }
mkdirSync(join(root, 'extensions', FRAMES_FOLDER, 'dist'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FRAMES_FOLDER, 'dist', 'client.js'),
  `export default { nodes: [{ type: 'zone', name: 'Zone' }, { type: 'gadget', name: 'Gadget', defaultData: ${JSON.stringify(GADGET_DEFAULTS)} }] }\n`,
)

const registry = getSpacesRegistry()
await registry.ensureLoaded()

async function spaceWithNode(label: string, nodeId: string): Promise<{ slug: string; address: string }> {
  const slug = `graph-actions-${label}-${suffix}`
  const space = await registry.create(slug, slug, {
    nodes: [{ id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { text: label } }],
    edges: [],
  })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, `space ${slug} has its default graph`)
  return { slug: space.slug, address: `${space.slug}.${graph.slug}` }
}

const X_NODE = `x-node-${suffix}`
const Y_NODE = `y-node-${suffix}`
const x = await spaceWithNode('x', X_NODE)
const y = await spaceWithNode('y', Y_NODE)

const catalog = await listAppCatalog()
const lookalikeEntry = catalog.find((entry) => entry.type === qualifyType(LOOKALIKE_FOLDER, 'graph'))
const [lookalikeRow] = lookalikeEntry
  ? await db
      .insert(spaceApp)
      .values({
        spaceId: registry.getBySlug(x.slug)?.id ?? '',
        type: lookalikeEntry.type,
        name: 'Lookalike',
        slug: 'lookalike',
      })
      .returning()
  : []
const lookalikeAddress = `${x.slug}.lookalike`

function text(result: Record<string, unknown>): string {
  return (result.content as { text: string }[])[0]?.text ?? ''
}

async function graphNodeIds(address: string): Promise<string[]> {
  const loaded = await loadSpaceGraphImpl(address)
  assert.ok(loaded, `${address} loads`)
  return loaded.graph.nodes.map((n) => (n as { id: string }).id).sort()
}

async function pendingApproval(tool: string) {
  for (let i = 0; i < 400; i++) {
    const request = approvalStore.list().find((r) => r.tool === tool)
    if (request) {
      return request
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no approval was requested for ${tool}`)
}

// The controls. Every assertion below is about what happens to a graph app or
// an extension app; if either did not resolve, they would quantify over nothing.
test('CONTROL: both graphs resolve as host graph apps, and the lookalike as an extension app', async () => {
  assert.equal((await hostAppCall(x.address, 'listNodes'))?.key, 'graph.listNodes')
  assert.equal((await hostAppCall(y.address, 'listNodes'))?.key, 'graph.listNodes')
  assert.ok(lookalikeRow, 'the catalog lists the lookalike extension, so its app row exists')
  assert.equal(parseType(lookalikeRow.type)?.bare, 'graph', 'and it is an App named `graph`')
  assert.equal(await hostAppCall(lookalikeAddress, 'listNodes'), undefined, 'which the host does not implement')
  assert.equal(isYoloMode(), false, 'the gate tests below mean nothing with YOLO on')
})

// ── address isolation ────────────────────────────────────────────────

test('a read of X returns X’s nodes and none of Y’s', async () => {
  const listed = JSON.parse(
    text(await handleToolCall('app_call', { app: x.address, action: 'listNodes' }, { internal: true })),
  ) as { id: string }[]
  assert.deepEqual(listed.map((n) => n.id).sort(), await graphNodeIds(x.address))
  assert.ok(!listed.some((n) => n.id === Y_NODE), 'Y’s node is not in X’s listing')

  const found = JSON.parse(
    text(
      await handleToolCall(
        'app_call',
        { app: x.address, action: 'getNodes', params: { nodeIds: [X_NODE, Y_NODE] } },
        { internal: true },
      ),
    ),
  ) as { found: { id: string }[]; missing: string[] }
  assert.deepEqual(
    found.found.map((n) => n.id),
    [X_NODE],
  )
  assert.deepEqual(found.missing, [Y_NODE], 'a node of another space is missing from this graph')
})

test('a write to X lands in X and leaves Y’s graph unchanged', async () => {
  const yBefore = await loadSpaceGraphImpl(y.address)
  const created = JSON.parse(
    text(
      await handleToolCall(
        'app_call',
        {
          app: x.address,
          action: 'createNodes',
          params: { nodes: [{ type: GADGET, data: { text: 'new' } }] },
        },
        { internal: true },
      ),
    ),
  ) as { id: string }[]
  assert.equal(created.length, 1)
  assert.ok((await graphNodeIds(x.address)).includes(created[0].id), 'the node is in X')
  assert.deepEqual(await loadSpaceGraphImpl(y.address), yBefore, 'Y is untouched, byte for byte')
})

test('createNodes refuses a bare type, which no extension could ever claim', async () => {
  const before = await graphNodeIds(x.address)
  await assert.rejects(
    handleToolCall(
      'app_call',
      { app: x.address, action: 'createNodes', params: { nodes: [{ type: 'note' }] } },
      { internal: true },
    ),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /"note" is not a qualified node type/)
      return true
    },
  )
  assert.deepEqual(await graphNodeIds(x.address), before, 'and nothing was created')
})

// ── node types ───────────────────────────────────────────────────────

async function createRefusal(nodes: Record<string, unknown>[]): Promise<string> {
  let message = ''
  await assert.rejects(
    handleToolCall('app_call', { app: x.address, action: 'createNodes', params: { nodes } }, { internal: true }),
    (err: { code?: number; message?: string }) => {
      assert.equal(err.code, -32602)
      message = err.message ?? ''
      return true
    },
  )
  return message
}

test('createNodes refuses a type no extension provides, naming the nearest registered ones', async () => {
  const before = await graphNodeIds(x.address)
  const cases: [label: string, type: string, hint: string][] = [
    ['a near-miss name', 'builtin.core.key-store', 'Did you mean "builtin.core.core-key-store"?'],
    ['a typo', qualifyType(FRAMES_FOLDER, 'gadgit'), `Did you mean "${GADGET}"?`],
    // A name the wanted bare name contains comes next: core's `get` in `gadget`.
    [
      'the right name under the wrong extension',
      'acme.widgets.gadget',
      `Did you mean "${GADGET}", "builtin.core.get"?`,
    ],
    ['a bare name', 'gadget', `Did you mean "${GADGET}", "builtin.core.get"?`],
  ]
  for (const [label, type, hint] of cases) {
    const message = await createRefusal([{ type }])
    assert.ok(message.includes(hint), `${label}: ${message}`)
    assert.match(message, /listNodeTypes lists every node type/, label)
  }
  assert.deepEqual(await graphNodeIds(x.address), before, 'and nothing was created')
})

test('with nothing near, the refusal lists the named extension’s types, or says it is not installed', async () => {
  const ofExtension = await createRefusal([{ type: qualifyType(FRAMES_FOLDER, 'nonexistent') }])
  assert.ok(
    ofExtension.includes(`${FRAMES_FOLDER} provides "${qualifyType(FRAMES_FOLDER, 'zone')}", "${GADGET}".`),
    ofExtension,
  )
  const noExtension = await createRefusal([{ type: `acme.nowhere-${suffix}.thing` }])
  assert.ok(noExtension.includes(`No installed extension is acme.nowhere-${suffix}.`), noExtension)
})

test('one unknown type refuses the whole batch, and every unknown type is named', async () => {
  const before = await graphNodeIds(x.address)
  const message = await createRefusal([{ type: GADGET }, { type: 'acme.widgets.zone' }, { type: 'gadgit' }])
  assert.match(message, /No node type "acme\.widgets\.zone"/)
  assert.match(message, /"gadgit" is not a qualified node type/)
  assert.doesNotMatch(message, new RegExp(`No node type "${GADGET}"`), 'the registered type is not refused')
  assert.deepEqual(await graphNodeIds(x.address), before, 'not even the registered one was created')
})

interface NodeTypeEntry {
  type: string
  label: string
  extension: string
  extensionName: string
  category?: string
  description?: string
  handles: { input: Record<string, unknown>[]; output: Record<string, unknown>[] }
}

async function listNodeTypes(query?: string): Promise<NodeTypeEntry[]> {
  const params = query === undefined ? {} : { query }
  return JSON.parse(
    text(await handleToolCall('app_call', { app: x.address, action: 'listNodeTypes', params }, { internal: true })),
  ) as NodeTypeEntry[]
}

test('listNodeTypes lists every installed extension’s node types with their extension, description and handles', async () => {
  const types = await listNodeTypes()
  // Control: core's types are in the population, not only the fixtures.
  const core = types.filter((t) => t.extension === 'builtin.core')
  assert.ok(
    core.some((t) => t.type === 'builtin.core.core-key-store'),
    'core’s types are listed',
  )
  assert.deepEqual(
    core.filter((t) => !t.description).map((t) => t.type),
    [],
    'every core type says what it is',
  )
  assert.deepEqual(
    types.find((t) => t.type === GADGET),
    {
      type: GADGET,
      label: 'Gadget',
      extension: FRAMES_FOLDER,
      extensionName: FRAMES_NAME,
      category: 'Applications',
      description: 'A gadget for the tests.',
      handles: {
        input: [{ id: 'text-in', handleType: 'builtin.core.text-stream', label: 'Text' }],
        output: [{ id: 'route-', handleType: 'builtin.core.terminal-context', dynamic: true }],
      },
    },
  )
  // Every listed type is one createNodes accepts.
  const zone = types.find((t) => t.type === qualifyType(FRAMES_FOLDER, 'zone'))
  assert.ok(zone, 'the frame is listed')
  assert.equal((await createOne({ type: zone.type })).type, zone.type)
})

test('listNodeTypes filters by query over type, label, extension name, category and description', async () => {
  const byDescription = await listNodeTypes('A GADGET FOR')
  assert.deepEqual(
    byDescription.map((t) => t.type),
    [GADGET],
  )
  const byExtensionName = (await listNodeTypes(FRAMES_NAME.toUpperCase())).map((t) => t.type).sort()
  assert.deepEqual(byExtensionName, [GADGET, qualifyType(FRAMES_FOLDER, 'zone')].sort())
  assert.deepEqual(await listNodeTypes(`nothing-${suffix}`), [])
})

// ── frames ───────────────────────────────────────────────────────────

interface StoredNode {
  id: string
  type: string
  data: Record<string, unknown>
  zIndex?: number
  style?: { width?: number; height?: number }
}

async function createOne(node: Record<string, unknown>): Promise<StoredNode> {
  const [created] = JSON.parse(
    text(
      await handleToolCall(
        'app_call',
        { app: x.address, action: 'createNodes', params: { nodes: [node] } },
        { internal: true },
      ),
    ),
  ) as { id: string }[]
  const loaded = await loadSpaceGraphImpl(x.address)
  const stored = loaded?.graph.nodes.find((n) => (n as { id: string }).id === created.id)
  assert.ok(stored, 'the created node is stored')
  return stored as unknown as StoredNode
}

test('createNodes starts a node with its type’s default data, as the palette does, under the data given', async () => {
  const bare = await createOne({ type: GADGET })
  assert.deepEqual(bare.data, GADGET_DEFAULTS)

  const given = await createOne({ type: GADGET, data: { text: 'mine', extra: true } })
  assert.deepEqual(given.data, { ...GADGET_DEFAULTS, text: 'mine', extra: true })

  // Control: a type whose bundle declares no defaults stores the given data alone.
  const zone = await createOne({ type: qualifyType(FRAMES_FOLDER, 'zone'), data: { label: 'z' } })
  assert.deepEqual(zone.data, { label: 'z' })
})

test('createNodes lays a frame out as the palette does: behind the rest, 400 × 300', async () => {
  const zone = await createOne({ type: qualifyType(FRAMES_FOLDER, 'zone'), position: { x: 0, y: 0 } })
  assert.equal(zone.zIndex, -1)
  assert.deepEqual(zone.style, { width: 400, height: 300 })
  // Control: a node of the same extension in another category gets no frame layout.
  const gadget = await createOne({ type: qualifyType(FRAMES_FOLDER, 'gadget') })
  assert.equal(gadget.zIndex, undefined)
  assert.equal(gadget.style, undefined)
})

test('createNodes and updateNodes write a given size', async () => {
  const zone = await createOne({ type: qualifyType(FRAMES_FOLDER, 'zone'), size: { width: 800, height: 600 } })
  assert.deepEqual(zone.style, { width: 800, height: 600 })
  assert.equal(zone.zIndex, -1, 'a frame given a size is still drawn behind')

  await handleToolCall(
    'app_call',
    {
      app: x.address,
      action: 'updateNodes',
      params: { updates: [{ nodeId: zone.id, size: { width: 300, height: 200 } }] },
    },
    { internal: true },
  )
  const loaded = await loadSpaceGraphImpl(x.address)
  const resized = loaded?.graph.nodes.find((n) => (n as { id: string }).id === zone.id) as unknown as StoredNode
  assert.deepEqual(resized.style, { width: 300, height: 200 })
})

test('createNodes and updateNodes round a given size up to the canvas grid', async () => {
  const zone = await createOne({ type: qualifyType(FRAMES_FOLDER, 'zone'), size: { width: 801, height: 595 } })
  assert.deepEqual(zone.style, { width: 810, height: 600 })

  await handleToolCall(
    'app_call',
    {
      app: x.address,
      action: 'updateNodes',
      params: { updates: [{ nodeId: zone.id, size: { width: 300.5, height: 209 } }] },
    },
    { internal: true },
  )
  const loaded = await loadSpaceGraphImpl(x.address)
  const resized = loaded?.graph.nodes.find((n) => (n as { id: string }).id === zone.id) as unknown as StoredNode
  assert.deepEqual(resized.style, { width: 310, height: 210 })
})

// ── frame members ────────────────────────────────────────────────────
// Agents read and write absolute positions; the graph stores a frame's
// members relative to it, with `parentId`. Each test has a graph of its own.

const ZONE = qualifyType(FRAMES_FOLDER, 'zone')

interface ReadNode {
  id: string
  parentId?: string
  position: { x: number; y: number }
}

async function treeGraph(
  label: string,
): Promise<{ address: string; call: (action: string, params: object) => Promise<unknown> }> {
  const { address } = await spaceWithNode(`tree-${label}`, `tree-${label}-${suffix}`)
  const call = async (action: string, params: object) =>
    JSON.parse(text(await handleToolCall('app_call', { app: address, action, params }, { internal: true })))
  return { address, call }
}

async function storedNode(address: string, id: string): Promise<ReadNode> {
  const loaded = await loadSpaceGraphImpl(address)
  return loaded?.graph.nodes.find((n) => (n as { id: string }).id === id) as unknown as ReadNode
}

async function readOne(call: (action: string, params: object) => Promise<unknown>, id: string): Promise<ReadNode> {
  const { found } = (await call('getNodes', { nodeIds: [id] })) as { found: ReadNode[] }
  return found[0]
}

test('a node created over a frame goes into it: stored relative, read absolute with its parentId', async () => {
  const { address, call } = await treeGraph('create')
  const [zone] = (await call('createNodes', { nodes: [{ type: ZONE, position: { x: 1000, y: 1000 } }] })) as ReadNode[]
  const [gadget] = (await call('createNodes', {
    nodes: [{ type: GADGET, position: { x: 1100, y: 1050 } }],
  })) as ReadNode[]
  assert.equal(gadget.parentId, zone.id)
  assert.deepEqual(gadget.position, { x: 1100, y: 1050 }, 'the answer is absolute')
  assert.deepEqual((await storedNode(address, gadget.id)).position, { x: 100, y: 50 })
  const read = await readOne(call, gadget.id)
  assert.deepEqual([read.parentId, read.position], [zone.id, { x: 1100, y: 1050 }])
  const listed = (await call('listNodes', {})) as { id: string; parentId?: string }[]
  assert.equal(listed.find((n) => n.id === gadget.id)?.parentId, zone.id)
  const [found] = (await call('findNodes', { patterns: [GADGET] })) as ReadNode[]
  assert.deepEqual([found.parentId, found.position], [zone.id, { x: 1100, y: 1050 }])
})

test('moving a frame moves its members, and a node moved out by position leaves it', async () => {
  const { address, call } = await treeGraph('move')
  const [zone, gadget] = (await call('createNodes', {
    nodes: [
      { type: ZONE, position: { x: 0, y: 0 } },
      { type: GADGET, position: { x: 40, y: 60 } },
    ],
  })) as ReadNode[]
  assert.equal(gadget.parentId, zone.id)
  await call('updateNodes', { updates: [{ nodeId: zone.id, position: { x: 500, y: 500 } }] })
  assert.deepEqual((await readOne(call, gadget.id)).position, { x: 540, y: 560 })
  assert.deepEqual((await storedNode(address, gadget.id)).position, { x: 40, y: 60 })

  const [moved] = (await call('updateNodes', {
    updates: [{ nodeId: gadget.id, position: { x: 2000, y: 0 } }],
  })) as ReadNode[]
  assert.equal(moved.parentId, undefined)
  assert.deepEqual((await storedNode(address, gadget.id)).position, { x: 2000, y: 0 })
})

test('a parentId given puts the node in that frame; one that does not hold the position is refused', async () => {
  const { call } = await treeGraph('parent')
  const [zone, gadget] = (await call('createNodes', {
    nodes: [
      { type: ZONE, position: { x: 0, y: 0 } },
      { type: GADGET, position: { x: 3000, y: 3000 } },
    ],
  })) as ReadNode[]
  const [placed] = (await call('updateNodes', { updates: [{ nodeId: gadget.id, parentId: zone.id }] })) as ReadNode[]
  assert.equal(placed.parentId, zone.id)
  assert.deepEqual(placed.position, { x: 10, y: 40 }, 'under the empty frame’s label')
  await assert.rejects(
    call('updateNodes', { updates: [{ nodeId: gadget.id, parentId: zone.id, position: { x: 900, y: 900 } }] }),
    { message: /lies outside frame .*, whose area is x 0 to 400, y 0 to 300/ },
  )
  const [out] = (await call('updateNodes', { updates: [{ nodeId: gadget.id, parentId: null }] })) as ReadNode[]
  assert.deepEqual([out.parentId, out.position], [undefined, { x: 10, y: 40 }])
})

test('a frame size too small for its members is refused, naming the smallest it can be', async () => {
  const { call } = await treeGraph('size')
  const [zone, gadget] = (await call('createNodes', {
    nodes: [
      { type: ZONE, position: { x: 0, y: 0 } },
      { type: GADGET, position: { x: 350, y: 250 } },
    ],
  })) as ReadNode[]
  assert.equal(gadget.parentId, zone.id)
  // The gadget has no stored size, so it takes the unsized room: it reaches (550, 390), plus one grid step.
  await assert.rejects(call('updateNodes', { updates: [{ nodeId: zone.id, size: { width: 200, height: 160 } }] }), {
    message: new RegExp(`size 200 × 160 of ${zone.id} is too small .* it needs at least 560 × 400`),
  })
})

test('a node created past its frame edge grows the frame to hold it', async () => {
  const { call } = await treeGraph('grow')
  const [zone] = (await call('createNodes', { nodes: [{ type: ZONE, position: { x: 0, y: 0 } }] })) as ReadNode[]
  const [gadget] = (await call('createNodes', {
    nodes: [{ type: GADGET, position: { x: 350, y: 250 } }],
  })) as ReadNode[]
  assert.equal(gadget.parentId, zone.id)
  const { found } = (await call('getNodes', { nodeIds: [zone.id] })) as { found: (ReadNode & { style?: unknown })[] }
  assert.deepEqual(found[0]?.style, { width: 560, height: 400 })
})

test('deleting a frame leaves its members where they are drawn', async () => {
  const { address, call } = await treeGraph('delete')
  const [zone, gadget] = (await call('createNodes', {
    nodes: [
      { type: ZONE, position: { x: 600, y: 600 } },
      { type: GADGET, position: { x: 700, y: 650 } },
    ],
  })) as ReadNode[]
  assert.equal(gadget.parentId, zone.id)
  await call('deleteNodes', { nodeIds: [zone.id] })
  const left = await storedNode(address, gadget.id)
  assert.equal(left.parentId, undefined)
  assert.deepEqual(left.position, { x: 700, y: 650 })
})

test('a size below the frame minimum, or not a pair of numbers, is refused and nothing is written', async () => {
  const before = await graphNodeIds(x.address)
  for (const size of [{ width: 100, height: 300 }, { width: 400 }, { width: '400', height: '300' }, null]) {
    await assert.rejects(
      handleToolCall(
        'app_call',
        {
          app: x.address,
          action: 'createNodes',
          params: { nodes: [{ type: qualifyType(FRAMES_FOLDER, 'zone'), size }] },
        },
        { internal: true },
      ),
      (err: { message?: string }) => {
        assert.match(err.message ?? '', /"size" must be \{ width, height \}/, JSON.stringify(size))
        return true
      },
    )
  }
  assert.deepEqual(await graphNodeIds(x.address), before)
})

test('focusNode on X does not find a node that exists only in Y', async () => {
  await assert.rejects(
    handleToolCall('app_call', { app: x.address, action: 'focusNode', params: { nodeId: Y_NODE } }, { internal: true }),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', new RegExp(`Node not found in ${x.address}`))
      return true
    },
  )
  // Control: the same node, on the graph that holds it, is found.
  const focused = await handleToolCall(
    'app_call',
    { app: y.address, action: 'focusNode', params: { nodeId: Y_NODE } },
    { internal: true },
  )
  assert.match(text(focused), new RegExp(`Focused on node ${Y_NODE} in ${y.address}`))
})

// ── required addresses ───────────────────────────────────────────────

test('an app_call without a graph address is refused, naming the address form', async () => {
  // A bare space slug was a node tool's default graph; an app address is always dotted.
  await assert.rejects(
    handleToolCall('app_call', { app: x.slug, action: 'listNodes' }, { internal: true }),
    /An app is addressed <space>\.<app-slug>/,
  )
})

test('app_list without a space is refused; "*" still lists every space', async () => {
  // A tool refusal is thrown as `{ code, message }`, not an Error.
  await assert.rejects(
    handleToolCall('app_list', {}, { internal: true }),
    (err: { code?: number; message?: string }) => {
      assert.equal(err.code, -32602)
      assert.match(err.message ?? '', /Missing required param: space/)
      return true
    },
  )
  const all = JSON.parse(text(await handleToolCall('app_list', { space: '*' }, { internal: true }))) as {
    apps: Record<string, unknown>
  }
  assert.ok(x.address in all.apps && y.address in all.apps, 'both graphs are listed under "*"')
})

// ── result format ────────────────────────────────────────────────────

test('JSON results reach the agent unindented, whether the action or the host serialised them', async () => {
  const compact = (raw: string) => assert.equal(raw, JSON.stringify(JSON.parse(raw)))
  // A graph action returns its own string; app_list is an object the host serialises.
  compact(text(await handleToolCall('app_call', { app: x.address, action: 'listNodes' }, { internal: true })))
  compact(text(await handleToolCall('app_list', { space: '*' }, { internal: true })))
})

// ── read-only classification ─────────────────────────────────────────

test('the graph’s reads are read-only; its writes and overlays are not', async () => {
  for (const action of ['listNodes', 'findNodes', 'getNodes', 'listNodeTypes', 'listEdges']) {
    assert.equal(await isReadOnlyToolCall('app_call', { app: x.address, action }), true, action)
  }
  for (const action of [
    'createNodes',
    'updateNodes',
    'writeNodeProperty',
    'deleteNodes',
    'focusNode',
    'commentNodes',
  ]) {
    assert.equal(await isReadOnlyToolCall('app_call', { app: x.address, action }), false, action)
  }
})

test('an extension App’s `listNodes` is not read-only, even on an App named `graph`', async () => {
  assert.equal(await isReadOnlyToolCall('app_call', { app: lookalikeAddress, action: 'listNodes' }), false)
})

test('an app_call that is missing, malformed or unresolvable is not read-only', async () => {
  const cases: [string, unknown][] = [
    ['no input', undefined],
    ['no app', { action: 'listNodes' }],
    ['no action', { app: x.address }],
    ['app not a string', { app: 42, action: 'listNodes' }],
    ['an address nothing answers to', { app: `nowhere-${suffix}.default`, action: 'listNodes' }],
    ['a bare space slug', { app: x.slug, action: 'listNodes' }],
    ['an action the graph does not declare', { app: x.address, action: 'dropEverything' }],
  ]
  for (const [label, input] of cases) {
    assert.equal(await isReadOnlyToolCall('app_call', input), false, label)
  }
})

// ── the approval gate ────────────────────────────────────────────────

test('a graph read is served without asking; a graph write asks in the graph’s space, with its view', async () => {
  // Not internal: this is the surface with the approval queue.
  const read = await handleToolCall('app_call', { app: x.address, action: 'listEdges' })
  assert.deepEqual(JSON.parse(text(read)), [], 'served straight away')

  const write = handleToolCall('app_call', {
    app: x.address,
    action: 'updateNodes',
    params: { updates: [{ nodeId: X_NODE, data: { text: 'approved' } }] },
  })
  const request = await pendingApproval('app_call')
  assert.equal(request.view, 'graph.updateNodes', 'the view the action declares')
  assert.equal(request.spaceId, x.slug, 'asked in the space of the graph it writes')
  approvalStore.approve(request.id)
  await write
  const loaded = await loadSpaceGraphImpl(x.address)
  const node = loaded?.graph.nodes.find((n) => (n as { id: string }).id === X_NODE) as { data?: { text?: string } }
  assert.equal(node.data?.text, 'approved', 'and runs once approved')
})

test('an extension App’s action keeps app_call’s own gate', async () => {
  const call = handleToolCall('app_call', { app: lookalikeAddress, action: 'listNodes' })
  const request = await pendingApproval('app_call')
  assert.equal(request.view, 'app_call')
  approvalStore.reject(request.id, 'test')
  const result = await call
  assert.equal(result.isError, true, 'rejected, never run')
})
