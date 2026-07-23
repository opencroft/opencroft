// Server-side background scheduler for Event nodes.
// Fires on a timer, independent of any open canvas tab or manual action —
// replaces the old manual-Fire-only flow and the previous (non-functional)
// version of this file.
//
// The previous event-scheduler called `dispatchNodeAction`, a TanStack Start
// `createServerFn`, directly from this bare `setInterval` tick — which has no
// request context whatsoever, so it failed on every tick for every due event
// with "No Start context found in AsyncLocalStorage" (fixed by the change
// which introduced the plain, non-server-fn dispatch path this file uses instead).
// Same fix category as docker-ps-poller.ts, which has always called its target
// action directly via `getExtensionModule(...).actions[...]` for the same reason.

import { CronExpressionParser } from 'cron-parser'

import { dispatchExecutionContext } from '@/app/(extension-runtime)/_server/exec-dispatch'
import { loadGraphPlain, saveGraphPlain, withGraphConflictRetry } from '@/app/(space)/_server/graph-conflict-retry'
import { getSpacesRegistry } from '@/app/(space)/_server/store'

export type ScheduleMode = 'simple' | 'cron'
export type ScheduleUnit = 'minutes' | 'hours' | 'days'
export type RunStatus = 'success' | 'error' | 'timeout'

export interface SimpleSchedule {
  every: number
  unit: ScheduleUnit
  weekdays?: string[]
  atTime?: string
}

// Matches the design-kit `Schedules` component's `ScheduleRule` contract exactly
// (opencroft/design-kit, project "opencroft", component "schedules") — this is
// the shape `data.schedules` stores and the canvas wiring passes straight
// through as the component's `rules` prop.
export interface ScheduleRule {
  id: string
  enabled: boolean
  mode: ScheduleMode
  cron: string
  /** Present for simple rules so the editor can repopulate the builder. */
  simple?: SimpleSchedule
  /**
   * Epoch ms, opportunistic. Refreshed for every enabled rule on a node
   * whenever that node is written for another reason (a fire) — never on an
   * idle tick, so it stays absent until a node's first fire. The canvas node
   * face and inspector use this (when present) as the server-authoritative
   * next-run time instead of re-deriving it from `cron` client-side.
   */
  nextRunAt?: number
}

// Raw/stored shape — deliberately not the component's `RunHistoryEntry` (which
// wants pre-formatted `time`/`duration` strings). The canvas wiring formats
// these at render time; storing raw numbers means the display format can
// change later without a data migration.
export interface RunHistoryEntry {
  id: string
  at: number
  status: RunStatus
  durationMs?: number
  error?: string
  /** Omitted when more than one rule was due in the same tick (ambiguous). */
  ruleId?: string
}

export const MAX_HISTORY = 20
export const TICK_MS = 10_000

interface EventNodeData {
  schedules?: ScheduleRule[]
  runHistory?: RunHistoryEntry[]
}

interface GraphNode {
  id: string
  type?: string
  data?: EventNodeData
}

// Due if the cron's next occurrence strictly after `windowStart` has already
// passed by `now`. An invalid expression never fires (matches the editor
// marking it "invalid" rather than crashing the tick).
function isDue(cron: string, windowStart: number, now: number): boolean {
  try {
    const next = CronExpressionParser.parse(cron, { currentDate: new Date(windowStart) }).next().toDate().getTime()
    return next <= now
  } catch {
    return false
  }
}

export function computeDueRuleIds(rules: ScheduleRule[], windowStart: number, now: number): string[] {
  return rules.filter((r) => r.enabled && isDue(r.cron, windowStart, now)).map((r) => r.id)
}

// The rule's next occurrence strictly after `now`. Undefined for an invalid
// expression — matches isDue's "never due" treatment rather than throwing.
export function computeNextRunAt(cron: string, now: number): number | undefined {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(now) }).next().toDate().getTime()
  } catch {
    return undefined
  }
}

function collectEventNodesBySpace(): Map<string, GraphNode[]> {
  const registry = getSpacesRegistry()
  const bySpace = new Map<string, GraphNode[]>()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const events = (space.graph.nodes as unknown as GraphNode[]).filter((n) => n.type === 'event')
    if (events.length > 0) {
      bySpace.set(summary.slug, events)
    }
  }
  return bySpace
}

// Per event-node dedup: if a fire from a previous tick is still running, skip
// it this tick rather than double-firing. This occurrence is then dropped, not
// deferred — windowStart has already advanced past it by the time the next
// tick runs, so it's never reconsidered. Consistent with the no-catch-up
// semantics elsewhere in this scheduler (a downtime miss is also just dropped),
// not a bug, but don't describe it as "will fire next tick".
// Keyed by slug+nodeId, not nodeId alone — node ids are only unique within a
// space, not across the whole registry.
const inFlight = new Set<string>()
function inFlightKey(slug: string, nodeId: string): string {
  return `${slug}:${nodeId}`
}

async function persistRunOutcome(
  slug: string,
  nodeId: string,
  dueRuleIds: string[],
  firedAt: number,
  outcome: { status: RunStatus; durationMs: number; error?: string },
): Promise<void> {
  // Deterministic, not Date.now()+Math.random() computed inside the mutate
  // closure: tied to the actual fire, not to whichever moment the mutate
  // callback happens to run. Belt-and-suspenders against an earlier bug
  // (a shared-object aliasing bug, fixed at its root in withGraphConflictRetry)
  // — even if some other bug someday causes this same outcome to be applied
  // twice, the dedup check below makes a second application a no-op instead of
  // a second history entry.
  const entryId = `run-${nodeId}-${firedAt}`
  try {
    await withGraphConflictRetry(
      slug,
      (graph) => {
        const node = (graph.nodes as unknown as GraphNode[]).find((n) => n.id === nodeId)
        if (!node) {
          // Deleted concurrently — nothing to persist. Reapply-not-recreate,
          // same rule as the MCP tools' conflict retry.
          return
        }
        const data = (node.data ??= {})
        // Opportunistic refresh: since this node is being written anyway,
        // recompute nextRunAt for every enabled rule too — not just the one(s)
        // that fired. Piggybacks on this write rather than adding a new class
        // of write; a rule that hasn't fired yet stays without a nextRunAt
        // until this node's first fire, same as any other rule here.
        const refreshedAt = Date.now()
        for (const rule of data.schedules ?? []) {
          if (rule.enabled) {
            rule.nextRunAt = computeNextRunAt(rule.cron, refreshedAt)
          }
        }
        const history = (data.runHistory ??= [])
        if (history.some((e) => e.id === entryId)) {
          return
        }
        const entry: RunHistoryEntry = {
          id: entryId,
          at: firedAt,
          status: outcome.status,
          durationMs: outcome.durationMs,
          error: outcome.error,
          ruleId: dueRuleIds.length === 1 ? dueRuleIds[0] : undefined,
        }
        history.unshift(entry)
        history.length = Math.min(history.length, MAX_HISTORY)
      },
      { load: loadGraphPlain, save: saveGraphPlain },
    )
  } catch (err) {
    console.error(`[event-scheduler] failed to persist run outcome for ${nodeId}:`, err)
  }
}

async function fireAndRecord(slug: string, nodeId: string, dueRuleIds: string[]): Promise<void> {
  const key = inFlightKey(slug, nodeId)
  if (inFlight.has(key)) {
    return
  }
  inFlight.add(key)
  const startedAt = Date.now()
  try {
    const summary = await dispatchExecutionContext({
      sourceNodeId: nodeId,
      sourceHandleId: 'exec-out',
      event: { type: 'event', nodeId, firedAt: startedAt, payload: {} },
    })
    await persistRunOutcome(slug, nodeId, dueRuleIds, startedAt, {
      status: summary.primary.error ? 'error' : 'success',
      durationMs: Date.now() - startedAt,
      error: summary.primary.error,
    })
  } catch (err) {
    await persistRunOutcome(slug, nodeId, dueRuleIds, startedAt, {
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inFlight.delete(key)
  }
}

// Exported (not just used by tick()) so tests can drive an explicit window
// without waiting on real wall-clock time or the module's own tick timer.
export async function processDueEvents(windowStart: number, now: number): Promise<void> {
  const bySpace = collectEventNodesBySpace()
  const fires: Promise<void>[] = []
  for (const [slug, nodes] of bySpace) {
    for (const node of nodes) {
      const dueRuleIds = computeDueRuleIds(node.data?.schedules ?? [], windowStart, now)
      if (dueRuleIds.length > 0) {
        fires.push(fireAndRecord(slug, node.id, dueRuleIds))
      }
    }
  }
  await Promise.all(fires)
}

// Start of the current tick's due-ness window. Reset to "now" on
// startEventScheduler(), so on restart any occurrence that would have fired
// while the process was down is simply never checked — missed firings during
// downtime are silently skipped, not caught up on restart.
let windowStart = Date.now()

async function tick(): Promise<void> {
  const now = Date.now()
  const start = windowStart
  windowStart = now
  await getSpacesRegistry().ensureLoaded()
  await processDueEvents(start, now)
}

interface SchedulerHandle {
  timer: NodeJS.Timeout
}

const globalForScheduler = globalThis as unknown as { __EVENT_SCHEDULER__?: SchedulerHandle }

export function startEventScheduler(): void {
  if (globalForScheduler.__EVENT_SCHEDULER__) {
    return
  }
  windowStart = Date.now()
  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[event-scheduler] tick failed', err)
    })
  }, TICK_MS)
  globalForScheduler.__EVENT_SCHEDULER__ = { timer }
  console.log(`[event-scheduler] started (tick every ${TICK_MS}ms)`)
}
