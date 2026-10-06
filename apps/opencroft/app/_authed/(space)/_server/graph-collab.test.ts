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
