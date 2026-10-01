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
          params: { nodes: [{ type: 'acme.notes.note', data: { text: 'new' } }] },
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
  for (const action of ['listNodes', 'findNodes', 'getNodes', 'listEdges']) {
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
