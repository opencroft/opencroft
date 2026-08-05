// Exercises the real database (embedded PGlite by default) and the real
// builtin/core extension bundle — same setup as
// app/(extension-runtime)/_server/exec-dispatch-no-context.test.ts. See
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

import { MAX_HISTORY, processDueEvents, type RunHistoryEntry, type ScheduleRule } from './event-scheduler'

function schedulesOf(slug: string, eventId: string): ScheduleRule[] {
  return (getSpacesRegistry().getBySlug(slug)?.graph.nodes.find((n) => (n as { id: string }).id === eventId) as {
    data?: { schedules?: ScheduleRule[] }
  })?.data?.schedules ?? []
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
      { id: eventId, type: 'event', position: { x: 0, y: 0 }, data: { schedules } },
      {
        id: scriptId,
        type: 'script',
        position: { x: 200, y: 0 },
        data: {
          language: 'node',
          script: "function handler(event) { return { status: 200, body: { ok: true } }; }",
        },
      },
    ],
    edges: [{ id: 'edge-1', source: eventId, target: scriptId, sourceHandle: 'exec-out', targetHandle: 'exec-in' }],
  })
  return eventId
}

function historyOf(slug: string, eventId: string): RunHistoryEntry[] {
  return (getSpacesRegistry().getBySlug(slug)?.graph.nodes.find((n) => (n as { id: string }).id === eventId) as {
    data?: { runHistory?: RunHistoryEntry[] }
  })?.data?.runHistory ?? []
}

test('processDueEvents fires a due rule, persists success, and broadcasts once', async () => {
  const slug = `scheduler-fire-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [{ id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' }])

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
  const before = getSpacesRegistry().getBySlug(slug)?.updatedAt.getTime()

  const now = Date.now()
  await processDueEvents(now - 5_000, now)

  const after = getSpacesRegistry().getBySlug(slug)?.updatedAt.getTime()
  assert.equal(after, before, 'updatedAt must not change when no rule fired — no write, no broadcast')
  assert.deepEqual(historyOf(slug, eventId), [])
})

test('processDueEvents ignores a disabled rule even when its slot is due', async () => {
  const slug = `scheduler-disabled-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [{ id: 'r1', enabled: false, mode: 'cron', cron: '* * * * *' }])
  const before = getSpacesRegistry().getBySlug(slug)?.updatedAt.getTime()

  await processDueEvents(Date.now() - 65_000, Date.now())

  const after = getSpacesRegistry().getBySlug(slug)?.updatedAt.getTime()
  assert.equal(after, before)
  assert.deepEqual(historyOf(slug, eventId), [])
})

test('processDueEvents caps run history at MAX_HISTORY, newest first', async () => {
  const slug = `scheduler-cap-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [{ id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' }])

  // No inter-iteration delay: each fire gets its own identity (fireId), not
  // one derived from Date.now(), so back-to-back calls landing in the same
  // millisecond no longer collide.
  for (let i = 0; i < MAX_HISTORY + 3; i++) {
    await processDueEvents(Date.now() - 65_000, Date.now())
  }

  const history = historyOf(slug, eventId)
  assert.equal(history.length, MAX_HISTORY)
  // Newest entry first.
  assert.ok(history[0].at >= history[history.length - 1].at)
})

// Freezes Date.now() so two genuinely separate processDueEvents calls read
// the identical millisecond, rather than waiting for real fires to collide
// by chance -- drives the clock instead of racing it.
test('processDueEvents records two separate fires that land in the same millisecond as two separate history entries', async () => {
  const slug = `scheduler-same-ms-${crypto.randomUUID()}`
  const eventId = await freshSpaceWithEventAndScript(slug, [{ id: 'r1', enabled: true, mode: 'cron', cron: '* * * * *' }])

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
  assert.equal(history.length, 2, 'two genuinely separate fires must both be recorded, even when Date.now() reads identically for both')
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
        type: 'event',
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
