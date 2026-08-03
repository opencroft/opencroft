import assert from 'node:assert/strict'
import test from 'node:test'

import { GraphConflictError, MAX_GRAPH_CONFLICT_RETRIES, withGraphConflictRetry } from './graph-conflict-retry'

// `load`/`save` are faked here (see the injectable deps on withGraphConflictRetry)
// so these tests exercise the retry/give-up control flow in isolation, without a
// live TanStack Start request context or a database.

test('withGraphConflictRetry succeeds on the first attempt when nothing else writes', async () => {
  let loadCalls = 0
  let savedGraph: unknown
  const result = await withGraphConflictRetry(
    'slug',
    (graph) => {
      ;(graph.nodes as unknown[]).push({ id: 'a' })
      return 'ok'
    },
    {
      load: async () => {
        loadCalls++
        return { graph: { nodes: [], edges: [] }, updatedAt: 'v1' }
      },
      save: async (_slug, graph, expectedUpdatedAt) => {
        assert.equal(expectedUpdatedAt, 'v1')
        savedGraph = graph
      },
    },
  )
  assert.equal(result, 'ok')
  assert.equal(loadCalls, 1)
  assert.deepEqual(savedGraph, { nodes: [{ id: 'a' }], edges: [] })
})

test('withGraphConflictRetry reloads and reapplies the mutation after a simulated conflict', async () => {
  let loadCalls = 0
  let saveCalls = 0
  const savedGraphs: unknown[] = []
  const result = await withGraphConflictRetry(
    'slug',
    (graph) => {
      ;(graph.nodes as { id: string }[]).push({ id: 'mine' })
      return (graph.nodes as unknown[]).length
    },
    {
      load: async () => {
        loadCalls++
        // The second load observes a node a competing writer added after our first load.
        const nodes = loadCalls > 1 ? [{ id: 'competitor' }] : []
        return { graph: { nodes, edges: [] }, updatedAt: `v${loadCalls}` }
      },
      save: async (_slug, graph, expectedUpdatedAt) => {
        saveCalls++
        savedGraphs.push(structuredClone(graph))
        if (saveCalls === 1) {
          // First save loses the race to a concurrent writer.
          throw new GraphConflictError('slug')
        }
        assert.equal(expectedUpdatedAt, 'v2')
      },
    },
  )
  assert.equal(loadCalls, 2, 'should reload once after the conflict')
  assert.equal(saveCalls, 2)
  assert.equal(result, 2, 'result reflects the reapplied mutation against the reloaded graph')
  assert.deepEqual(savedGraphs[1], { nodes: [{ id: 'competitor' }, { id: 'mine' }], edges: [] })
})

// Regression test: both real `load` implementations
// (loadGraphPlain and loadViaAction) return the space registry's live, shared
// graph object by reference, not a copy — calling a createServerFn in-process
// has no serialization boundary, same as the plain path. If `mutate` runs
// directly against that shared object, a failed attempt's mutation is never
// rolled back: it stays on the live object, and the next attempt's `load`
// returns that same already-dirty object, so retrying compounds the mutation
// instead of cleanly reapplying it (concretely: two run-history entries
// persisted for one scheduler fire, when a concurrent canvas autosave raced
// the scheduler's own save).
test('withGraphConflictRetry does not compound a failed attempt onto a shared, mutable graph object', async () => {
  const sharedGraph = { nodes: [] as { id: string }[], edges: [] }
  let loadCalls = 0
  let saveCalls = 0
  const savedGraphs: unknown[] = []
  await withGraphConflictRetry(
    'slug',
    (graph) => {
      ;(graph.nodes as { id: string }[]).push({ id: `entry-${loadCalls}` })
    },
    {
      load: async () => {
        loadCalls++
        // Same object every call — mimics the real registry, unlike the test
        // above which hands back a fresh literal each time.
        return { graph: sharedGraph, updatedAt: `v${loadCalls}` }
      },
      save: async (_slug, graph) => {
        saveCalls++
        savedGraphs.push(structuredClone(graph))
        if (saveCalls === 1) {
          throw new GraphConflictError('slug')
        }
      },
    },
  )
  assert.equal(loadCalls, 2)
  assert.equal(saveCalls, 2)
  // The successful (second) save must reflect only the retry's own mutation —
  // not the first, failed attempt's mutation compounded on top via the shared
  // reference.
  assert.deepEqual(savedGraphs[1], { nodes: [{ id: 'entry-2' }], edges: [] })
  // The caller's own object must never be directly mutated by a failed attempt.
  assert.deepEqual(sharedGraph.nodes, [])
})

test('withGraphConflictRetry gives up after MAX_GRAPH_CONFLICT_RETRIES and rethrows GraphConflictError', async () => {
  let loadCalls = 0
  let saveCalls = 0
  await assert.rejects(
    () =>
      withGraphConflictRetry(
        'slug',
        (graph) => {
          ;(graph.nodes as unknown[]).push({ id: 'mine' })
        },
        {
          load: async () => {
            loadCalls++
            return { graph: { nodes: [], edges: [] }, updatedAt: `v${loadCalls}` }
          },
          save: async () => {
            saveCalls++
            // Every attempt loses the race.
            throw new GraphConflictError('slug')
          },
        },
      ),
    GraphConflictError,
  )
  assert.equal(loadCalls, MAX_GRAPH_CONFLICT_RETRIES)
  assert.equal(saveCalls, MAX_GRAPH_CONFLICT_RETRIES)
})

test('withGraphConflictRetry propagates a non-conflict error immediately, without retrying', async () => {
  let loadCalls = 0
  const notFound = { code: -32602, message: 'Node not found: target' }
  await assert.rejects(
    () =>
      withGraphConflictRetry(
        'slug',
        (graph) => {
          const node = (graph.nodes as { id: string }[]).find((n) => n.id === 'target')
          if (!node) {
            // Same "not found" validation the real MCP handlers already do on a fresh
            // graph — reused here as the concurrent-delete signal, not a special case.
            throw notFound
          }
        },
        {
          load: async () => {
            loadCalls++
            // Target is gone by the time this runs — e.g. deleted by another writer.
            return { graph: { nodes: [], edges: [] }, updatedAt: 'v1' }
          },
          save: async () => {
            throw new Error('save should not be reached when mutate throws')
          },
        },
      ),
    (err: unknown) => err === notFound,
  )
  // Fails on the very first pass — a plain validation error is not a GraphConflictError,
  // so it is never retried and the target is never recreated.
  assert.equal(loadCalls, 1)
})
