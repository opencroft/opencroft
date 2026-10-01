import { legacy } from '@opencroft/client'
const { NodeFrame, OutputHandle, React, Schedules, icons } = legacy
type KitRunHistoryEntry = legacy.RunHistoryEntry
type KitScheduleRule = legacy.ScheduleRule
type UpcomingRun = legacy.UpcomingRun

const { useEffect, useState } = React

// ── Persisted data shape ──────────────────────────────────────────────
// Matches the server scheduler's shape exactly (server/scheduler/event-scheduler.ts,
// the Event node scheduler) and the design-kit `Schedules` component's
// `ScheduleRule` contract for the fields the component itself owns. `nextRunAt`
// is opportunistic: the scheduler only (re)computes and persists it when it's
// already writing for another reason (a fire), never on an idle tick — so it's
// absent until a rule has fired at least once.

export type ScheduleMode = 'simple' | 'cron'
export type ScheduleUnit = 'minutes' | 'hours' | 'days'
export type RunStatus = 'success' | 'error' | 'timeout'

export interface SimpleSchedule {
  every: number
  unit: ScheduleUnit
  weekdays?: string[]
  atTime?: string
}

export interface EventScheduleRule {
  id: string
  enabled: boolean
  mode: ScheduleMode
  cron: string
  simple?: SimpleSchedule
  /** Epoch ms. Set by the server after a fire or when the rule changes; absent until then. */
  nextRunAt?: number
}

export interface EventRunHistoryEntry {
  id: string
  /** Epoch ms. */
  at: number
  status: RunStatus
  durationMs?: number
  error?: string
  ruleId?: string
}

export interface EventData {
  schedules?: EventScheduleRule[]
  runHistory?: EventRunHistoryEntry[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// All scheduling math is UTC (cron-parser's default, server-side, no `tz` option
// passed) — format the same way here so the displayed times actually match when
// the scheduler will fire, regardless of the viewer's local timezone.
function formatAbsoluteUtc(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

function formatRelative(ms: number, now: number): string {
  const diff = ms - now
  if (diff <= 0) {
    return 'now'
  }
  const sec = Math.floor(diff / 1000)
  if (sec < 60) {
    return `in ${sec}s`
  }
  const min = Math.floor(sec / 60)
  if (min < 60) {
    return `in ${min}m ${sec % 60}s`
  }
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    return `in ${hr}h ${min % 60}m`
  }
  const day = Math.floor(hr / 24)
  return `in ${day}d ${hr % 24}h`
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) {
    return undefined
  }
  return `${(ms / 1000).toFixed(1)}s`
}

function useNow(intervalMs: number = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function soonestNextRunAt(schedules: EventScheduleRule[] | undefined): number | undefined {
  let soonest: number | undefined
  for (const rule of schedules ?? []) {
    if (!rule.enabled || rule.nextRunAt === undefined) {
      continue
    }
    if (soonest === undefined || rule.nextRunAt < soonest) {
      soonest = rule.nextRunAt
    }
  }
  return soonest
}

const STATUS_DOT: Record<RunStatus, string> = {
  success: 'bg-green-500',
  error: 'bg-destructive',
  timeout: 'bg-amber-500',
}

export function EventNode({ data, selected }: { id: string; data: EventData; selected?: boolean }) {
  const now = useNow(1000)
  const next = soonestNextRunAt(data.schedules)
  const lastStatus = data.runHistory?.[0]?.status
  const ruleCount = (data.schedules ?? []).filter((r) => r.enabled).length

  return (
    <NodeFrame
      icon={icons.AlarmClock}
      title="Event"
      subtitle={ruleCount === 0 ? 'No schedules' : `${ruleCount} schedule${ruleCount === 1 ? '' : 's'}`}
      selected={selected ?? false}
      output={<OutputHandle type="execution-context" id="exec-out" />}
      extra={
        <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          {lastStatus ? <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[lastStatus]}`} /> : null}
          {next !== undefined ? <span>{formatRelative(next, now)}</span> : null}
        </div>
      }
    />
  )
}

interface InspectorProps {
  nodeId: string
  data: EventData
  updateData: (p: Partial<EventData>) => void
}

// upcoming is only passed as a server-authoritative override when every
// enabled, valid rule already has a persisted nextRunAt — otherwise a rule that
// hasn't fired yet would be silently missing from an override list (passing
// `upcoming` replaces the component's own preview, it doesn't merge with it).
// With no override the component falls back to previewing every rule with its
// own pure-TS cron engine — best-effort by construction; the server (cron-parser)
// is the actual source of truth for when a rule fires. If they ever disagree on
// an edge-case expression, trust the server (run history), not the preview.
function serverUpcoming(schedules: EventScheduleRule[] | undefined): UpcomingRun[] | undefined {
  const enabled = (schedules ?? []).filter((r) => r.enabled)
  if (enabled.length === 0 || enabled.some((r) => r.nextRunAt === undefined)) {
    return undefined
  }
  return enabled
    .map((r) => ({ id: r.id, time: formatAbsoluteUtc(r.nextRunAt as number), ruleId: r.id, at: r.nextRunAt as number }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 5)
    .map(({ id, time, ruleId }) => ({ id, time, ruleId }))
}

function toKitHistory(history: EventRunHistoryEntry[] | undefined): KitRunHistoryEntry[] {
  return (history ?? []).map((entry) => ({
    id: entry.id,
    time: formatAbsoluteUtc(entry.at),
    status: entry.status,
    duration: formatDuration(entry.durationMs),
    error: entry.error,
  }))
}

export function EventInspector({ data, updateData }: InspectorProps) {
  const rules = (data.schedules ?? []) as KitScheduleRule[]
  return (
    <Schedules
      rules={rules}
      history={toKitHistory(data.runHistory)}
      timezone="UTC"
      upcoming={serverUpcoming(data.schedules)}
      onRulesChange={(next) => updateData({ schedules: next as EventScheduleRule[] })}
    />
  )
}

export const EVENT_HANDLES = [
  { id: 'exec-out', handleType: 'execution-context', role: 'source' as const, label: 'Handler' },
]

export function eventExposeOutput(handleId: string): Record<string, never> | undefined {
  if (handleId !== 'exec-out') {
    return undefined
  }
  return {}
}
