// Exercises the real database (embedded PGlite by default) and the real
// builtin/core extension bundle — same setup as
// app/(extension-runtime)/_server/exec-dispatch-no-context.test.ts. See
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { getCollabServer } from '@/server/collab/collab-server'
import { MAX_HISTORY, processDueEvents, type RunHistoryEntry, type ScheduleRule } from './event-scheduler'

// The scheduler writes a fire's outcome through the graph's document, held by
// an in-process collaboration server until it is unloaded.
test.after(async () => {
  const server = getCollabServer()
  for (const document of [...server.documents.values()]) {
    await server.unloadDocument(document)
  }
})

// The space's nodes across its graphs -- the created space keeps everything on
// its default graph, but the lookup should not care.
function nodesOf(slug: string): Record<string, unknown>[] {
  const space = getSpacesRegistry().getBySlug(slug)
  return space ? [...space.graphs.values()].flatMap((g) => g.graph.nodes) : []
}

// The default graph's own updatedAt: graph writes land on the graph row now,
// so this is the timestamp a fired (or not-fired) rule does or does not move.
function graphUpdatedAt(slug: string): number | undefined {
  const space = getSpacesRegistry().getBySlug(slug)
  return space?.graphs.get(space.defaultGraphSlug)?.updatedAt.getTime()
}

function schedulesOf(slug: string, eventId: string): ScheduleRule[] {
  return (
    (
      nodesOf(slug).find((n) => (n as { id: string }).id === eventId) as {
        data?: { schedules?: ScheduleRule[] }
      }
    )?.data?.schedules ?? []
  )
}

// dispatchExecutionContext resolves a node by id alone, searching every space
// (safe in production since node ids are real UUIDs, globally unique) — so
// each test space here needs its own unique node ids too, not shared literals
// like "event-1", or a test could accidentally dispatch to a different test's
// node of the same name in another space.
async function freshSpaceWithEventAndScript(slug: string, schedules: ScheduleRule[]): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const eventId = `${slug}-event`
  const scriptId = `${slug}-script`
  await registry.create(slug, slug, {
    nodes: [
      { id: eventId, type: 'builtin.core.event', position: { x: 0, y: 0 }, data: { schedules } },
      {
        id: scriptId,
        type: 'script',
        position: { x: 200, y: 0 },
        data: {
          language: 'node',
          script: 'function handler(event) { return { status: 200, body: { ok: true } }; }',
        },
      },
    ],
    edges: [{ id: 'edge-1', source: eventId, target: scriptId, sourceHandle: 'exec-out', targetHandle: 'exec-in' }],
  })
  return eventId
}

function historyOf(slug: string, eventId: string): RunHistoryEntry[] {
  return (
    (
      nodesOf(slug).find((n) => (n as { id: string }).id === eventId) as {
        data?: { runHistory?: RunHistoryEntry[] }
      }
    )?.data?.runHistory ?? []
  )
}

test('processDueEvents fires a due rule, persists success, and broadcasts once', async () => {
  const slug = `scheduler-fire-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [
    { id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' },
  ])

  const windowStart = Date.now() - 65_000 // a whole minute back, guaranteed to have a due slot
  await processDueEvents(windowStart, Date.now())

  const history = historyOf(slug, eventId)
  assert.equal(history.length, 1)
  assert.equal(history[0].status, 'success')
  assert.equal(history[0].ruleId, 'r1')
  assert.equal(typeof history[0].durationMs, 'number')

  // Opportunistic nextRunAt refresh: piggybacks on this same write, so it's
  // populated right after the first fire even though nothing edited the rule.
  const [rule] = schedulesOf(slug, eventId)
  assert.equal(typeof rule.nextRunAt, 'number')
  assert.ok((rule.nextRunAt as number) > Date.now(), 'nextRunAt should be in the future')
})

test('processDueEvents does not touch the graph when nothing is due', async () => {
  const slug = `scheduler-idle-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [
    // Fires once a year on Jan 1st — guaranteed not due in any short test window.
    { id: 'r1', enabled: true, mode: 'cron', cron: '0 0 1 1 *' },
  ])
  const before = graphUpdatedAt(slug)

  const now = Date.now()
  await processDueEvents(now - 5_000, now)

  const after = graphUpdatedAt(slug)
  assert.equal(after, before, 'updatedAt must not change when no rule fired — no write, no broadcast')
  assert.deepEqual(historyOf(slug, eventId), [])
})

test('processDueEvents ignores a disabled rule even when its slot is due', async () => {
  const slug = `scheduler-disabled-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [
    { id: 'r1', enabled: false, mode: 'cron', cron: '* * * * *' },
  ])
  const before = graphUpdatedAt(slug)

  await processDueEvents(Date.now() - 65_000, Date.now())

  const after = graphUpdatedAt(slug)
  assert.equal(after, before)
  assert.deepEqual(historyOf(slug, eventId), [])
})

test('processDueEvents caps run history at MAX_HISTORY, newest first', async (t) => {
  const slug = `scheduler-cap-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [
    { id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' },
  ])
  // A run outcome that fails to persist is logged and dropped, not thrown, so
  // this is the only place a missing entry can be explained from.
  const errors = t.mock.method(console, 'error')

  // The clock is driven, a second per fire, rather than read: an entry is
  // stamped with the time its fire started, and "newest first" is a claim about
  // those stamps, which off the real clock rests on it never stepping back.
  // Each fire still gets its own identity (fireId), so calls a real clock would
  // put in the same millisecond do not collide either.
  const fires = MAX_HISTORY + 3
  const start = Date.now()
  const realDateNow = Date.now
  try {
    for (let i = 0; i < fires; i++) {
      Date.now = () => start + i * 1000
      await processDueEvents(Date.now() - 65_000, Date.now())
    }
  } finally {
    Date.now = realDateNow
  }

  const history = historyOf(slug, eventId)
  // On failure, says what was recorded and what the scheduler logged.
  const recorded = () =>
    JSON.stringify({
      entries: history.map((entry) => ({ fire: (entry.at - start) / 1000, status: entry.status, error: entry.error })),
      logged: errors.mock.calls.map((call) => call.arguments.map(String).join(' ')),
    })
  assert.equal(history.length, MAX_HISTORY, `${fires} fires left ${history.length} entries: ${recorded()}`)
  // Newest first: the last MAX_HISTORY fires, latest at the top.
  assert.deepEqual(
    history.map((entry) => entry.at),
    Array.from({ length: MAX_HISTORY }, (_, k) => start + (fires - 1 - k) * 1000),
    recorded(),
  )
})

// Freezes Date.now() so two genuinely separate processDueEvents calls read
// the identical millisecond, rather than waiting for real fires to collide
// by chance -- drives the clock instead of racing it.
test('processDueEvents records two separate fires that land in the same millisecond as two separate history entries', async () => {
  const slug = `scheduler-same-ms-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [
    { id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' },
  ])

  const frozenNow = Date.now()
  const realDateNow = Date.now
  Date.now = () => frozenNow
  try {
    await processDueEvents(frozenNow - 65_000, frozenNow)
    await processDueEvents(frozenNow - 65_000, frozenNow)
  } finally {
    Date.now = realDateNow
  }

  const history = historyOf(slug, eventId)
  assert.equal(
    history.length,
    2,
    'two genuinely separate fires must both be recorded, even when Date.now() reads identically for both',
  )
})

test('processDueEvents records a failed dispatch as an error entry, not a crash', async () => {
  const slug = `scheduler-error-${crypto.randomUUID()}`
  const eventId = `${slug}-event`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  // Event node with no connected handler at all — dispatchExecutionContext
  // throws NoExecTargetError, which must be caught and recorded, not propagated.
  await registry.create(slug, slug, {
    nodes: [
      {
        id: eventId,
        type: 'builtin.core.event',
        position: { x: 0, y: 0 },
        data: { schedules: [{ id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' }] },
      },
    ],
    edges: [],
  })

  await processDueEvents(Date.now() - 65_000, Date.now())

  const history = historyOf(slug, eventId)
  assert.equal(history.length, 1)
  assert.equal(history[0].status, 'error')
  assert.ok(history[0].error?.includes('No target connected'))
})

// ── the graph a node actually lives on ─────────────────────────────────────
//
// Every fixture above keeps its event node on the space's default graph, and
// the comment at `nodesOf` says the lookup should not care. That is true of the
// lookup and was false of the persist: the write re-derived its address from a
// bare space slug, which resolves to the DEFAULT graph, so a node anywhere else
// was searched for in a graph it is not in. Nothing was recorded, and the
// unchanged clone was saved anyway — a byte-identical write a minute, forever.
//
// These read the graph directly rather than through `nodesOf`, because
// flattening every graph of the space is exactly what hid this.

function graphOf(slug: string, graphSlug: string) {
  return getSpacesRegistry().getBySlug(slug)?.graphs.get(graphSlug)
}

function nodesOnGraph(slug: string, graphSlug: string): Record<string, unknown>[] {
  return (graphOf(slug, graphSlug)?.graph.nodes ?? []) as Record<string, unknown>[]
}

function historyOnGraph(slug: string, graphSlug: string, eventId: string): RunHistoryEntry[] {
  const node = nodesOnGraph(slug, graphSlug).find((n) => (n as { id: string }).id === eventId) as {
    data?: { runHistory?: RunHistoryEntry[] }
  }
  return node?.data?.runHistory ?? []
}

function defaultGraphSlugOf(slug: string): string {
  const space = getSpacesRegistry().getBySlug(slug)
  assert.ok(space, `space ${slug} must exist`)
  return space.defaultGraphSlug
}

/**
 * A space whose event node lives on a graph OTHER than its default.
 *
 * The default graph is created with the space and deliberately left EMPTY, so
 * anything that appears in it afterwards arrived by a write that went to the
 * wrong address — which makes the negative assertion below a real one rather
 * than a comparison of two timestamps.
 */
async function freshSpaceWithEventOnNamedGraph(
  slug: string,
  graphSlug: string,
  schedules: ScheduleRule[],
  { connectScript = true }: { connectScript?: boolean } = {},
): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, { nodes: [], edges: [] })
  await registry.createGraph(slug, graphSlug, graphSlug, `instance-${crypto.randomUUID()}`)
  const eventId = `${slug}-event`
  const scriptId = `${slug}-script`
  const graph = {
    nodes: [
      { id: eventId, type: 'builtin.core.event', position: { x: 0, y: 0 }, data: { schedules } },
      ...(connectScript
        ? [
            {
              id: scriptId,
              type: 'script',
              position: { x: 200, y: 0 },
              data: {
                language: 'node',
                script: 'function handler(event) { return { status: 200, body: { ok: true } }; }',
              },
            },
          ]
        : []),
    ],
    edges: connectScript
      ? [{ id: 'edge-1', source: eventId, target: scriptId, sourceHandle: 'exec-out', targetHandle: 'exec-in' }]
      : [],
  }
  await mutateLiveGraph(`${slug}.${graphSlug}`, { kind: 'system', name: 'test setup' }, (current) => {
    current.nodes = graph.nodes
    current.edges = graph.edges
  })
  return eventId
}

test('an event node on a named graph records its outcome on that graph, and the space default is not written', async () => {
  const slug = `scheduler-named-${crypto.randomUUID()}`
  const graphSlug = 'jobs'
  const eventId = await freshSpaceWithEventOnNamedGraph(slug, graphSlug, [
    { id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' },
  ])
  const defaultSlug = defaultGraphSlugOf(slug)
  const defaultBefore = graphUpdatedAt(slug)

  await processDueEvents(Date.now() - 65_000, Date.now())

  const history = historyOnGraph(slug, graphSlug, eventId)
  assert.equal(history.length, 1, 'the outcome is recorded, on the graph the node is actually on')
  assert.equal(history[0].status, 'success')
  assert.equal(history[0].ruleId, 'r1')

  // The nextRunAt refresh rides the same write, so it proves the same thing.
  const [rule] = schedulesOf(slug, eventId)
  assert.equal(typeof rule.nextRunAt, 'number')

  // Pins the reported symptom directly: the space default was being written
  // once a minute with byte-identical content, and must not be written at all.
  assert.equal(graphUpdatedAt(slug), defaultBefore, 'the space default graph must not be written')
  assert.deepEqual(nodesOnGraph(slug, defaultSlug), [], 'and nothing may appear in it')
})

test('a dispatch that throws on a named graph lands an error entry on that graph', async () => {
  // The half that makes this High, and it gets its own test because a fix can
  // silently leave it broken: the catch persists through the same path as the
  // success, so before this a failing schedule and a working one were
  // indistinguishable — both recorded nothing, anywhere.
  const slug = `scheduler-named-error-${crypto.randomUUID()}`
  const graphSlug = 'jobs'
  const eventId = await freshSpaceWithEventOnNamedGraph(
    slug,
    graphSlug,
    [{ id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' }],
    { connectScript: false },
  )

  await processDueEvents(Date.now() - 65_000, Date.now())

  const history = historyOnGraph(slug, graphSlug, eventId)
  assert.equal(history.length, 1, 'a failure is visible where the node lives')
  assert.equal(history[0].status, 'error')
  assert.ok(history[0].error?.includes('No target connected'))
  assert.deepEqual(nodesOnGraph(slug, defaultGraphSlugOf(slug)), [], 'and not in the space default')
})

test('an event node on the space default graph still records, now addressed explicitly', async () => {
  // The working case, kept working. It matters because the address is built as
  // `<space>.<graph>` for defaults too: this no longer travels through
  // resolveGraph's `?? defaultGraphSlug` fallback, which is the re-derivation
  // being retired. Same behaviour, different route — so the route needs a test,
  // or a fix that only works while the fallback still catches it would pass.
  const slug = `scheduler-default-explicit-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [
    { id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' },
  ])
  const defaultSlug = defaultGraphSlugOf(slug)
  const before = graphUpdatedAt(slug)

  await processDueEvents(Date.now() - 65_000, Date.now())

  const history = historyOnGraph(slug, defaultSlug, eventId)
  assert.equal(history.length, 1, 'a default-graph node still records')
  assert.equal(history[0].status, 'success')
  assert.notEqual(graphUpdatedAt(slug), before, 'and its own graph is the one that was written')
})
