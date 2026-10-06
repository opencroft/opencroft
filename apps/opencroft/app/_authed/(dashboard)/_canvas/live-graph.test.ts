// Two canvas tabs on one live graph, over a real socket: a collaboration
// server on the loopback interface and LiveGraph instances, as browsers
// would hold them. A tab writes what it changed relative to the graph its
// view came from (`base`); what others wrote meanwhile must survive that.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { Server } from '@hocuspocus/server'

import { LiveGraph } from '@/app/_authed/(dashboard)/_canvas/live-graph'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { STALE_LINEAGE_REASON } from '@/lib/collab-protocol'

const LINEAGE = 'lineage-1'
const EMPTY: GraphData = { nodes: [], edges: [] }

let server: Server
let url: string
const opened: LiveGraph[] = []

before(async () => {
  server = new Server({
    port: 0,
    address: '127.0.0.1',
    quiet: true,
    stopOnSignals: false,
    async onAuthenticate({ token }) {
      if (token !== LINEAGE) {
        // Refused the way the app's server refuses it: Hocuspocus sends the
        // client the error's `reason`.
        throw Object.assign(new Error(STALE_LINEAGE_REASON), { reason: STALE_LINEAGE_REASON })
      }
    },
  })
  await server.listen()
  url = `ws://127.0.0.1:${server.address.port}`
})

after(async () => {
  for (const graph of opened) {
    graph.destroy()
  }
  await server.destroy()
})

interface Tab {
  live: LiveGraph
  /** The graph as of the latest change this tab did not write. */
  seen: () => GraphData
  stale: () => boolean
}

function openTab(docName: string, { lineage = LINEAGE, initial = EMPTY } = {}): Tab {
  let seen = initial
  let stale = false
  const live = new LiveGraph({
    session: { docName, lineage },
    initial,
    url,
    onRemoteChange: (_before, after) => {
      seen = after
    },
    onStale: () => {
      stale = true
    },
  })
  opened.push(live)
  return { live, seen: () => seen, stale: () => stale }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Node = Record<string, unknown> & { id: string }
const node = (id: string, label = id): Node => ({ id, type: 'acme.kit.log', position: { x: 0, y: 0 }, data: { label } })
const ids = (graph: GraphData) => graph.nodes.map((n) => n.id as string).sort()
const nodeIn = (graph: GraphData, id: string) => graph.nodes.find((n) => n.id === id) as Node | undefined
const labelIn = (graph: GraphData, id: string) => (nodeIn(graph, id)?.data as { label?: string } | undefined)?.label

test('a write in one tab reaches the other as a change it did not make', async () => {
  const name = `graph:${crypto.randomUUID()}`
  const a = openTab(name)
  const b = openTab(name)
  a.live.write({ nodes: [node('from-a')], edges: [] }, EMPTY)
  await until(() => ids(b.seen()).includes('from-a'), "tab b to see tab a's node")
})

test('undo in one tab reverts its own step only, and the other tab sees it', async () => {
  const name = `graph:${crypto.randomUUID()}`
  const a = openTab(name)
  const b = openTab(name)
  b.live.write({ nodes: [node('from-b')], edges: [] }, EMPTY)
  await until(() => ids(a.seen()).includes('from-b'), "tab a to see tab b's node")
  const view = a.seen()
  a.live.write({ nodes: [...view.nodes, node('from-a')], edges: [] }, view)
  await until(() => ids(b.seen()).includes('from-a'), "tab b to see tab a's node")

  assert.deepEqual(a.live.undo(), { applied: true, keptNodeIds: [] })
  assert.deepEqual(ids(a.seen()), ['from-b'])
  await until(() => !ids(b.seen()).includes('from-a'), "tab b to see tab a's undo")
  assert.deepEqual(ids(b.seen()), ['from-b'])
  // Tab b's history is its own, untouched by tab a's undo.
  assert.equal(b.live.undo()?.applied, true)
})

test("an edit made before the first sync lands without undoing what others wrote since the tab's fetch", async () => {
  const name = `graph:${crypto.randomUUID()}`
  const writer = openTab(name)
  const watcher = openTab(name)
  writer.live.write({ nodes: [node('kept'), node('edited')], edges: [] }, EMPTY)
  await until(() => ids(watcher.seen()).length === 2, 'the first graph to land')
  // What a new tab's fetch returns...
  const fetched = watcher.seen()
  // ...and what another writer does after that fetch.
  writer.live.write(
    { nodes: [node('kept'), node('edited', 'changed after the fetch'), node('created')], edges: [] },
    fetched,
  )
  await until(() => ids(watcher.seen()).includes('created'), 'the later change to land')

  // The new tab starts from the older fetch and edits before it has synced.
  const late = openTab(name, { initial: fetched })
  late.live.write({ nodes: [node('kept', 'edited before sync'), node('edited')], edges: [] }, fetched)

  await until(() => labelIn(watcher.seen(), 'kept') === 'edited before sync', 'the early edit to land')
  const merged = watcher.seen()
  assert.deepEqual(ids(merged), ['created', 'edited', 'kept'])
  assert.equal(labelIn(merged, 'edited'), 'changed after the fetch')
  // The tab is shown the document it wrote into, the later change included.
  await until(() => ids(late.seen()).includes('created'), 'the early tab to see the whole graph')
})

test('a write from a view that has not taken in a remote change leaves that change alone', async () => {
  const name = `graph:${crypto.randomUUID()}`
  const agent = openTab(name)
  const person = openTab(name)
  const first: GraphData = { nodes: [node('n1')], edges: [] }
  agent.live.write(first, EMPTY)
  await until(() => ids(person.seen()).includes('n1'), 'the first node to land')
  // The person's view as last rendered.
  const view = person.seen()

  // A change arrives in the person's copy of the document...
  agent.live.write({ nodes: [node('n1', 'renamed by the agent'), node('agent-made')], edges: [] }, first)
  await until(() => ids(person.seen()).includes('agent-made'), "the agent's change to reach the person's copy")

  // ...and the person writes a move from the view that predates it.
  const moved = { ...(nodeIn(view, 'n1') as Node), position: { x: 300, y: 0 } }
  person.live.write({ nodes: [moved], edges: [] }, view)

  await until(() => (nodeIn(agent.seen(), 'n1')?.position as { x: number } | undefined)?.x === 300, 'the move to land')
  const merged = agent.seen()
  assert.deepEqual(ids(merged), ['agent-made', 'n1'])
  assert.equal(labelIn(merged, 'n1'), 'renamed by the agent')
})

test('a tab holding another lineage of the document is told to start over', async () => {
  const stale = openTab(`graph:${crypto.randomUUID()}`, { lineage: 'an-older-lineage' })
  await until(() => stale.stale(), 'the stale tab to be told')
})
