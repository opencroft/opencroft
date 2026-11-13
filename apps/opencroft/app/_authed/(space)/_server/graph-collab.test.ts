// Graphs synced through their Yjs documents, end to end on the server: the
// write path every server-side writer takes, the projection every reader
// reads, and the preparation that keeps a stored document in step with the
// stored JSON. Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env -- and an in-process collaboration server.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'

import { collabDocUpdate, db, spaceGraph } from '@opencroft/db'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'

import { graphDocName } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { applyGraphToDoc } from '@/app/_authed/(space)/_lib/graph-doc'
import {
  graphDocType,
  mutateLiveGraph,
  prepareLiveGraphs,
  registerGraphDocType,
} from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { STALE_LINEAGE_REASON } from '@/lib/collab-protocol'
import { getCollabServer, storeAllCollabDocs } from '@/server/collab/collab-server'
import { createCollabDoc, loadCollabDoc } from '@/server/collab/collab-store'

const ORIGIN = { kind: 'agent', name: 'agent-a' } as const
const USER = { id: 'user-1', name: 'alice' }

before(() => {
  registerGraphDocType()
})

after(async () => {
  const server = getCollabServer()
  for (const document of [...server.documents.values()]) {
    await server.unloadDocument(document)
  }
})

function node(id: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'acme.kit.log', position: { x: 0, y: 0 }, data }
}

async function liveSpace(graph: GraphData = { nodes: [node('seed')], edges: [] }) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `graph-collab-${crypto.randomUUID()}`
  const space = await registry.create(slug, slug, graph)
  const ref = space.graphs.get(space.defaultGraphSlug)
  assert.ok(ref)
  await prepareLiveGraphs()
  return { address: slug, graphId: ref.id, ref }
}

async function storedData(graphId: string): Promise<string> {
  const [row] = await db.select({ data: spaceGraph.data }).from(spaceGraph).where(eq(spaceGraph.id, graphId))
  return row.data
}

async function unloadAll(): Promise<void> {
  const server = getCollabServer()
  for (const document of [...server.documents.values()]) {
    await server.unloadDocument(document)
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('a write to a graph lands in the registry at once and in the stored graph once stored', async () => {
  const { address, graphId, ref } = await liveSpace()
  await mutateLiveGraph(address, ORIGIN, (graph) => {
    graph.nodes.push(node('written'))
  })
  assert.deepEqual(
    ref.graph.nodes.map((n) => n.id),
    ['seed', 'written'],
  )
  await storeAllCollabDocs()
  const data = await storedData(graphId)
  assert.deepEqual(
    (JSON.parse(data) as GraphData).nodes.map((n) => n.id),
    ['seed', 'written'],
  )
  const stored = await loadCollabDoc(graphDocName(graphId))
  assert.equal(stored?.sourceVersion, sha256(data))
})

test('a burst of writes is recorded in a few update rows, not one per write', async () => {
  const { address, graphId } = await liveSpace()
  const writes = 20
  for (let i = 0; i < writes; i++) {
    await mutateLiveGraph(address, ORIGIN, (graph) => {
      ;(graph.nodes[0].data as Record<string, unknown>).log = `line ${i}`.repeat(200)
    })
  }
  const rows = async () => {
    const found = await db
      .select()
      .from(collabDocUpdate)
      .where(eq(collabDocUpdate.name, graphDocName(graphId)))
    return found.length
  }
  const deadline = Date.now() + 10_000
  while ((await rows()) === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const recorded = await rows()
  assert.ok(recorded > 0, 'the burst was recorded')
  assert.ok(recorded < 5, `${recorded} rows for ${writes} writes`)
})

test('concurrent writers to a graph each run once and both land', async () => {
  const { address, ref } = await liveSpace()
  let runs = 0
  const write = (id: string) =>
    mutateLiveGraph(address, ORIGIN, (graph) => {
      runs += 1
      graph.nodes.push(node(id))
    })
  await Promise.all([write('first'), write('second')])
  assert.equal(runs, 2)
  assert.deepEqual(ref.graph.nodes.map((n) => n.id).sort(), ['first', 'second', 'seed'])
})

test('preparing a graph whose document is in step keeps its lineage', async () => {
  const { graphId } = await liveSpace()
  const lineage = (await loadCollabDoc(graphDocName(graphId)))?.lineage
  assert.ok(lineage)
  await prepareLiveGraphs()
  assert.equal((await loadCollabDoc(graphDocName(graphId)))?.lineage, lineage)
})

test('a graph written without its document is rebuilt from the stored graph under a new lineage', async () => {
  const { graphId, ref } = await liveSpace()
  await unloadAll()
  const lineage = (await loadCollabDoc(graphDocName(graphId)))?.lineage
  const written: GraphData = { nodes: [node('written-elsewhere')], edges: [] }
  await db
    .update(spaceGraph)
    .set({ data: JSON.stringify(written) })
    .where(eq(spaceGraph.id, graphId))
  await prepareLiveGraphs()
  const rebuilt = await loadCollabDoc(graphDocName(graphId))
  assert.ok(rebuilt)
  assert.notEqual(rebuilt.lineage, lineage)
  assert.deepEqual(
    ref.graph.nodes.map((n) => n.id),
    ['written-elsewhere'],
  )
})

test('edits recorded after the last snapshot reach the registry when the graph is prepared', async () => {
  const { graphId, ref } = await liveSpace()
  await unloadAll()
  // A stored document ahead of the stored JSON, as a stop between an edit and
  // the next snapshot leaves it.
  const data = await storedData(graphId)
  const ahead = new Y.Doc()
  applyGraphToDoc(ahead, { nodes: [node('seed'), node('unsnapshotted')], edges: [] })
  await createCollabDoc(graphDocName(graphId), {
    state: Y.encodeStateAsUpdate(ahead),
    sourceVersion: sha256(data),
    schemaVersion: 1,
  })
  await prepareLiveGraphs()
  assert.deepEqual(
    ref.graph.nodes.map((n) => n.id),
    ['seed', 'unsnapshotted'],
  )
})

function placed(id: string, x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...node(id), position: { x, y }, ...extra }
}

// A Section, the core frame type, as a graph stored before frames had members holds one.
const oldSection = placed('S', 100, 100, { type: 'builtin.core.section', style: { width: 400, height: 300 } })

test('a graph stored before the frame tree is converted once, from its document, and written back', async () => {
  const { graphId, ref } = await liveSpace()
  await unloadAll()
  const old: GraphData = { nodes: [oldSection, placed('inside', 150, 200), placed('outside', 900, 900)], edges: [] }
  const oldData = JSON.stringify(old)
  await db.update(spaceGraph).set({ data: oldData }).where(eq(spaceGraph.id, graphId))
  // Its document holds an edit made after the last snapshot.
  const ahead = new Y.Doc()
  applyGraphToDoc(ahead, { nodes: [...old.nodes, placed('late', 120, 150)], edges: [] })
  await createCollabDoc(graphDocName(graphId), {
    state: Y.encodeStateAsUpdate(ahead),
    sourceVersion: sha256(oldData),
    schemaVersion: 1,
  })

  await prepareLiveGraphs()

  const byId = new Map(ref.graph.nodes.map((n) => [n.id, n]))
  assert.equal(byId.get('inside')?.parentId, 'S')
  assert.deepEqual(byId.get('inside')?.position, { x: 50, y: 100 })
  assert.equal(byId.get('late')?.parentId, 'S')
  assert.deepEqual(byId.get('late')?.position, { x: 20, y: 50 })
  assert.equal(byId.get('outside')?.parentId, undefined)
  const data = await storedData(graphId)
  const stored = JSON.parse(data) as GraphData & { version?: number }
  assert.equal(stored.version, 2)
  assert.deepEqual(
    stored.nodes.map((n) => [n.id, n.parentId ?? null]),
    [
      ['S', null],
      ['inside', 'S'],
      ['outside', null],
      ['late', 'S'],
    ],
  )
  const doc = await loadCollabDoc(graphDocName(graphId))
  assert.equal(doc?.sourceVersion, sha256(data))
  assert.equal(doc?.schemaVersion, 2)

  // Prepared again, it is in step: nothing is converted or rebuilt.
  await prepareLiveGraphs()
  assert.equal((await loadCollabDoc(graphDocName(graphId)))?.lineage, doc?.lineage)
  assert.equal(await storedData(graphId), data)
})

test('a graph stored before the frame tree with no document is converted from its JSON', async () => {
  const { graphId, ref } = await liveSpace()
  await unloadAll()
  const old: GraphData = { nodes: [oldSection, placed('inside', 150, 200)], edges: [] }
  await db
    .update(spaceGraph)
    .set({ data: JSON.stringify(old) })
    .where(eq(spaceGraph.id, graphId))
  await prepareLiveGraphs()
  assert.equal(ref.graph.nodes.find((n) => n.id === 'inside')?.parentId, 'S')
  assert.equal((JSON.parse(await storedData(graphId)) as { version?: number }).version, 2)
})

test('a server write that leaves a member of a deleted frame clears its parent, where it is drawn', async () => {
  const { address, ref } = await liveSpace()
  await mutateLiveGraph(address, ORIGIN, (graph) => {
    graph.nodes = [placed('kid', 20, 30, { parentId: 'gone' })]
  })
  assert.deepEqual(ref.graph.nodes, [placed('kid', 20, 30)])
})

test('a graph holding replaced value nodes holds Value and Convert after a write that changes nothing else', async () => {
  const at = { x: 10, y: 20 }
  const { address, ref } = await liveSpace({
    nodes: [
      { id: 'n', type: 'builtin.core.number-value', position: at, data: { value: 3 } },
      { id: 'tb', type: 'builtin.core.to-boolean', position: at, data: {} },
    ],
    edges: [{ id: 'e', source: 'n', sourceHandle: 'value', target: 'tb', targetHandle: 'value' }],
  } as unknown as GraphData)
  // What the startup refresh of every graph's contexts writes.
  await mutateLiveGraph(address, { kind: 'system', name: 'context refresh' }, () => undefined)
  const nodes = ref.graph.nodes as unknown as { id: string; type: string; position: unknown; data: object }[]
  assert.deepEqual(
    nodes.map((n) => [n.id, n.type, n.position]),
    [
      ['n', 'builtin.core.value', at],
      ['tb', 'builtin.core.convert', at],
    ],
  )
  assert.deepEqual(
    ref.graph.edges.map((e) => `${e.source}/${e.sourceHandle} -> ${e.target}/${e.targetHandle}`),
    ['n/value -> tb/value'],
  )
})

test('a client is refused for a stale lineage and accepted for the current one', async () => {
  const { graphId } = await liveSpace()
  const name = graphDocName(graphId)
  const lineage = (await loadCollabDoc(name))?.lineage
  assert.ok(lineage)
  // The reason, not the message, is what reaches the client.
  await assert.rejects(graphDocType.authorize(name, USER, 'some-older-lineage'), { reason: STALE_LINEAGE_REASON })
  await graphDocType.authorize(name, USER, lineage)
})

test('a graph with a repeated id gets a document without the repeat, and is written through it', async () => {
  const { address, graphId, ref } = await liveSpace({ nodes: [node('dup'), node('dup', { other: true })], edges: [] })
  assert.ok(await loadCollabDoc(graphDocName(graphId)))
  assert.deepEqual(ref.graph.nodes, [node('dup')])
  await mutateLiveGraph(address, ORIGIN, (graph) => {
    graph.nodes.push(node('written'))
  })
  await storeAllCollabDocs()
  assert.deepEqual(
    (JSON.parse(await storedData(graphId)) as GraphData).nodes.map((n) => n.id),
    ['dup', 'written'],
  )
})

test('removing a space removes the documents of its graphs', async () => {
  const { address, graphId } = await liveSpace()
  assert.ok(await loadCollabDoc(graphDocName(graphId)))
  await getSpacesRegistry().remove(address)
  // The document is removed after the space, without the removal waiting on it.
  const deadline = Date.now() + 10_000
  while ((await loadCollabDoc(graphDocName(graphId))) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(await loadCollabDoc(graphDocName(graphId)), null)
})

// Listeners are registered for the whole run, and other tests remove nodes too: each test checks
// for its own ids among what was announced.
function collectRemovedNodes(): string[] {
  const removed: string[] = []
  getSpacesRegistry().onNodesRemoved((nodeIds) => removed.push(...nodeIds))
  return removed
}

test('a node deleted from a live graph is announced as removed, and one kept is not', async () => {
  const gone = `gone-${crypto.randomUUID()}`
  const kept = `kept-${crypto.randomUUID()}`
  const { address } = await liveSpace({ nodes: [node(gone), node(kept)], edges: [] })
  const removed = collectRemovedNodes()

  await mutateLiveGraph(address, ORIGIN, (graph) => {
    graph.nodes = graph.nodes.filter((n) => (n as { id: string }).id !== gone)
  })

  assert.ok(removed.includes(gone))
  assert.ok(!removed.includes(kept))
})

test('removing a space announces the nodes of its graphs as removed', async () => {
  const inside = `inside-${crypto.randomUUID()}`
  const { address } = await liveSpace({ nodes: [node(inside)], edges: [] })
  const removed = collectRemovedNodes()

  await getSpacesRegistry().remove(address)

  assert.ok(removed.includes(inside))
})

// A server in one space and, in another, a Terminal Router with a route to it
// whose stored context names the host it had before.
async function routedServer() {
  const serverId = `server-${crypto.randomUUID()}`
  const servers = await liveSpace({
    nodes: [{ id: serverId, type: 'builtin.core.server', position: { x: 0, y: 0 }, data: { address: 'a.example' } }],
    edges: [],
  })
  const routerNode = (target: string) => ({
    id: `router-${crypto.randomUUID()}`,
    type: 'builtin.core.terminal-router',
    position: { x: 0, y: 0 },
    data: { routes: [{ id: 'r1', target, context: { type: 'ssh', host: 'stale.example' } }] },
  })
  const routing = await liveSpace({ nodes: [routerNode(`${serverId}/terminal`)], edges: [] })
  const unrelated = await liveSpace({ nodes: [routerNode(`elsewhere-${crypto.randomUUID()}/terminal`)], edges: [] })
  return { servers, serverId, routing, unrelated }
}

function routedHost(ref: Awaited<ReturnType<typeof liveSpace>>['ref']): unknown {
  const router = ref.graph.nodes[0] as { data: { routes: { context?: { host?: string } }[] } }
  return router.data.routes[0].context?.host
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a change to a server re-resolves the routes to it in other graphs, opened or not', async () => {
  const { servers, serverId, routing, unrelated } = await routedServer()
  await unloadAll()

  await mutateLiveGraph(servers.address, ORIGIN, (graph) => {
    const server = graph.nodes.find((n) => n.id === serverId) as { data: Record<string, unknown> }
    server.data.address = 'b.example'
  })

  await until(() => routedHost(routing.ref) === 'b.example')
  assert.equal(routedHost(routing.ref), 'b.example')
  // A router routing elsewhere is not touched by the change.
  assert.equal(routedHost(unrelated.ref), 'stale.example')
})
