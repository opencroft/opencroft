'use client'

import { useState, type ReactNode } from 'react'
import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  History,
  Pencil,
  Plus,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'

import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/components/ui/collapsible'
import { Input } from 'ui/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui/components/ui/select'
import { Separator } from 'ui/components/ui/separator'
import { Switch } from 'ui/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from 'ui/components/ui/tabs'
import { cn } from 'ui/lib/utils'

// ── Public types ───────────────────────────────────────────────────
// The component owns the editor UI state and the cron engine (build / validate
// / humanize / next-runs). Props describe persisted domain truth only — never
// widget state. Wire it by loading rules, passing them, and persisting on
// `onRulesChange`.

export type ScheduleMode = 'simple' | 'cron'
export type ScheduleUnit = 'minutes' | 'hours' | 'days'
export type RunStatus = 'success' | 'error' | 'running' | 'timeout'

export interface SimpleSchedule {
  every: number
  unit: ScheduleUnit
  /** Mon–Sun; meaningful for the `days` unit. */
  weekdays?: string[]
  /** "HH:MM"; meaningful for the `days` unit. */
  atTime?: string
}

// The persisted shape — also the contract the scheduler stores
// for every rule.
export interface ScheduleRule {
  id: string
  enabled: boolean
  mode: ScheduleMode
  cron: string
  /** Present for simple rules so the editor can repopulate the builder. */
  simple?: SimpleSchedule
}

export interface RunHistoryEntry {
  id: string
  time: string
  status: RunStatus
  duration?: string
  error?: string
}

export interface UpcomingRun {
  id: string
  time: string
  ruleId?: string
  ruleSummary?: string
}

export interface SchedulesProps {
  rules: ScheduleRule[]
  history: RunHistoryEntry[]
  /** Server timezone label (shown in the combined preview). */
  timezone: string
  /** The only way rules leave the component — the host persists the next array. */
  onRulesChange?: (next: ScheduleRule[]) => void
  /** Optional server-authoritative override; the component previews from cron when omitted. */
  upcoming?: UpcomingRun[]
}

// ── Cron engine (pure, dependency-free, shipped with the component) ──
// Implemented in-house rather than via cron-parser / cronstrue so the component
// has no npm dependencies and renders anywhere (incl. the isolated preview).

const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }
const DOW_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function expandField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const raw of field.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? parseInt(stepPart, 10) : 1
    let lo: number
    let hi: number
    const range = rangePart.trim()
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = parseInt(a, 10)
      hi = parseInt(b, 10)
    } else {
      lo = parseInt(range, 10)
      hi = lo
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(step) || step <= 0) throw new Error('bad field')
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) out.add(v)
  }
  return out
}

interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

function parseCron(cron: string): ParsedCron | null {
  const parts = (cron ?? '').trim().split(/\s+/)
  if (parts.length < 5) return null
  try {
    const [mf, hf, df, monf, dowf] = parts
    const dow = expandField(dowf, 0, 7)
    if (dow.has(7)) {
      dow.delete(7)
      dow.add(0)
    }
    const parsed: ParsedCron = {
      minute: expandField(mf, 0, 59),
      hour: expandField(hf, 0, 23),
      dom: expandField(df, 1, 31),
      month: expandField(monf, 1, 12),
      dow,
      domRestricted: df !== '*',
      dowRestricted: dowf !== '*',
    }
    if (
      parsed.minute.size === 0 ||
      parsed.hour.size === 0 ||
      parsed.dom.size === 0 ||
      parsed.month.size === 0 ||
      parsed.dow.size === 0
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function validateCron(cron: string): boolean {
  return parseCron(cron) !== null
}

function nextFire(p: ParsedCron, from: Date): Date | null {
  const cur = new Date(from)
  cur.setUTCSeconds(0, 0)
  cur.setUTCMinutes(cur.getUTCMinutes() + 1)
  for (let guard = 0; guard < 366 * 24 * 60; guard++) {
    const mon = cur.getUTCMonth() + 1
    if (!p.month.has(mon)) {
      cur.setUTCMonth(cur.getUTCMonth() + 1, 1)
      cur.setUTCHours(0, 0, 0, 0)
      continue
    }
    const dom = cur.getUTCDate()
    const dow = cur.getUTCDay()
    const dayOk =
      p.domRestricted && p.dowRestricted ? p.dom.has(dom) || p.dow.has(dow) : p.dom.has(dom) && p.dow.has(dow)
    if (!dayOk) {
      cur.setUTCDate(cur.getUTCDate() + 1)
      cur.setUTCHours(0, 0, 0, 0)
      continue
    }
    const h = cur.getUTCHours()
    if (!p.hour.has(h)) {
      cur.setUTCHours(cur.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    const m = cur.getUTCMinutes()
    if (!p.minute.has(m)) {
      cur.setUTCMinutes(cur.getUTCMinutes() + 1, 0, 0)
      continue
    }
    return new Date(cur)
  }
  return null
}

function nextRuns(cron: string, count: number, from: number): Date[] {
  const p = parseCron(cron)
  if (!p) return []
  const out: Date[] = []
  let t = from
  for (let i = 0; i < count; i++) {
    const d = nextFire(p, new Date(t))
    if (!d) break
    out.push(d)
    t = d.getTime()
  }
  return out
}

// Best-effort human reading for common shapes; falls back to the raw expression.
export function humanizeCron(cron: string): string {
  const parts = (cron ?? '').trim().split(/\s+/)
  if (parts.length < 5) return cron || '—'
  const [mf, hf, df, monf, dowf] = parts
  const pad = (n: string) => n.padStart(2, '0')
  const dowNames = (f: string) =>
    f
      .split(',')
      .map((d) => DOW_ABBR[parseInt(d, 10) % 7] ?? d)
      .join(', ')
  const minStep = /^\*\/(\d+)$/.exec(mf)
  if (minStep && hf === '*' && df === '*' && monf === '*' && dowf === '*') {
    return `Every ${minStep[1]} minute${minStep[1] === '1' ? '' : 's'}`
  }
  const hourStep = /^\*\/(\d+)$/.exec(hf)
  if (hourStep && mf === '0' && df === '*' && monf === '*' && dowf === '*') {
    return `Every ${hourStep[1]} hour${hourStep[1] === '1' ? '' : 's'}`
  }
  if (/^\d+$/.test(mf) && /^\d+$/.test(hf) && monf === '*') {
    const time = `${pad(hf)}:${pad(mf)}`
    if (dowf !== '*') return `At ${time}, ${dowNames(dowf)}`
    if (df !== '*') return `On day ${df} of the month at ${time}`
    return `At ${time} every day`
  }
  return cron
}

function buildCron(s: SimpleSchedule): string {
  const every = s.every && s.every > 0 ? s.every : 1
  const t = /^(\d{1,2}):(\d{2})$/.exec((s.atTime ?? '').trim())
  if (s.unit === 'minutes') return `*/${every} * * * *`
  if (s.unit === 'hours') return `0 */${every} * * *`
  const dow =
    s.weekdays && s.weekdays.length
      ? s.weekdays
          .map((d) => DOW[d])
          .filter((x): x is number => x !== undefined)
          .sort((a, b) => a - b)
          .join(',')
      : '*'
  return `${t ? t[2] : '0'} ${t ? t[1] : '0'} * * ${dow}`
}

function summarize(rule: ScheduleRule): string {
  if (rule.mode === 'simple' && rule.simple) {
    const s = rule.simple
    const every = s.every && s.every > 0 ? s.every : 1
    if (s.unit === 'minutes') return `Every ${every} min`
    if (s.unit === 'hours') return `Every ${every} h`
    const days = s.weekdays && s.weekdays.length ? s.weekdays : undefined
    const dayLabel = !days || days.length === 7 ? 'Daily' : days.join(', ')
    return s.atTime ? `${dayLabel} at ${s.atTime}` : dayLabel
  }
  return humanizeCron(rule.cron) || rule.cron
}

function formatRunTime(d: Date): string {
  return `${DOW_ABBR[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function computeUpcoming(rules: ScheduleRule[], count: number): UpcomingRun[] {
  const all: Array<{ t: number; run: UpcomingRun }> = []
  for (const r of rules) {
    if (!r.enabled || !validateCron(r.cron)) continue
    const runs = nextRuns(r.cron, count, Date.now())
    runs.forEach((d, i) =>
      all.push({
        t: d.getTime(),
        run: { id: `${r.id}-${i}`, time: formatRunTime(d), ruleId: r.id, ruleSummary: summarize(r) },
      }),
    )
  }
  all.sort((a, b) => a.t - b.t)
  return all.slice(0, count).map((x) => x.run)
}

// ── Editor UI state (internal) ──
interface EditorState {
  editingId: string | null
  mode: ScheduleMode
  every: number
  unit: ScheduleUnit
  weekdays: string[]
  atTime: string
  cron: string
}

function editorFromRule(rule: ScheduleRule): EditorState {
  if (rule.mode === 'simple' && rule.simple) {
    return {
      editingId: rule.id,
      mode: 'simple',
      every: rule.simple.every,
      unit: rule.simple.unit,
      weekdays: rule.simple.weekdays ?? [],
      atTime: rule.simple.atTime ?? '',
      cron: rule.cron,
    }
  }
  return { editingId: rule.id, mode: 'cron', every: 30, unit: 'minutes', weekdays: [], atTime: '', cron: rule.cron }
}

function freshEditor(): EditorState {
  return { editingId: null, mode: 'simple', every: 30, unit: 'minutes', weekdays: [], atTime: '', cron: '' }
}

let _idCounter = 0
function genId(): string {
  _idCounter += 1
  return `r${Date.now().toString(36)}${_idCounter}`
}

const STATUS_DOT: Record<RunStatus, string> = {
  success: 'bg-green-500',
  error: 'bg-destructive',
  running: 'bg-primary animate-pulse',
  timeout: 'bg-amber-500',
}
const STATUS_LABEL: Record<RunStatus, string> = {
  success: 'ok',
  error: 'failed',
  running: 'running',
  timeout: 'timeout',
}

// The Schedules inspector section for the Event node. Self-contained: editor
// state and the cron engine live inside; the host only persists rules.
export function Schedules({ rules, history, timezone, onRulesChange, upcoming }: SchedulesProps) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const upcomingView = upcoming ?? computeUpcoming(rules, 5)
  const commit = (next: ScheduleRule[]) => onRulesChange?.(next)

  const handleSave = () => {
    if (!editor) return
    const cron = editor.mode === 'simple' ? buildCron(editor) : editor.cron.trim()
    const existing = editor.editingId ? rules.find((r) => r.id === editor.editingId) : undefined
    const rule: ScheduleRule = {
      id: editor.editingId ?? genId(),
      enabled: existing ? existing.enabled : true,
      mode: editor.mode,
      cron,
      simple:
        editor.mode === 'simple'
          ? {
              every: editor.every,
              unit: editor.unit,
              weekdays: editor.weekdays.length ? editor.weekdays : undefined,
              atTime: editor.atTime || undefined,
            }
          : undefined,
    }
    const next = editor.editingId ? rules.map((r) => (r.id === editor.editingId ? rule : r)) : [...rules, rule]
    commit(next)
    setEditor(null)
  }

  return (
    <div className='flex w-full min-w-0 flex-col gap-3 text-xs'>
      <div className='flex items-center justify-between gap-2'>
        <SectionLabel icon={<CalendarClock className='size-3.5' />}>Schedules</SectionLabel>
        <Button size='sm' variant='outline' onClick={() => setEditor(freshEditor())} className='h-6 gap-1 px-2 text-[11px]'>
          <Plus className='size-3' />
          Add schedule
        </Button>
      </div>

      {rules.length === 0 ? (
        <EmptyHint>No schedules yet. Add one to run this event automatically.</EmptyHint>
      ) : (
        <div className='flex flex-col gap-1'>
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onToggle={(enabled) => commit(rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))}
              onEdit={() => setEditor(editorFromRule(rule))}
              onDelete={() => commit(rules.filter((r) => r.id !== rule.id))}
            />
          ))}
        </div>
      )}

      {editor ? (
        <ScheduleEditor editor={editor} onChange={setEditor} onSave={handleSave} onCancel={() => setEditor(null)} />
      ) : null}

      <Separator />
      <CombinedPreview upcoming={upcomingView} timezone={timezone} />

      <Separator />
      <RunHistory entries={history} />
    </div>
  )
}

function SectionLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className='flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground'>
      {icon}
      <span>{children}</span>
    </div>
  )
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className='rounded-md border border-dashed px-2.5 py-2 text-[11px] text-muted-foreground'>{children}</p>
}

function IconButton({
  label,
  destructive,
  onClick,
  children,
}: {
  label: string
  destructive?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        destructive && 'hover:text-destructive',
      )}
    >
      {children}
    </button>
  )
}

function RuleRow({
  rule,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: ScheduleRule
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const valid = validateCron(rule.cron)
  const next = rule.enabled && valid ? nextRuns(rule.cron, 1, Date.now())[0] : undefined
  return (
    <div className='flex items-center gap-2 rounded-md border px-2 py-1.5'>
      <Switch
        checked={rule.enabled}
        onCheckedChange={onToggle}
        aria-label={rule.enabled ? 'Pause schedule' : 'Enable schedule'}
      />
      <div className='flex min-w-0 flex-1 flex-col gap-0.5 leading-tight'>
        <span className={cn('truncate font-medium', rule.enabled ? 'text-foreground' : 'text-muted-foreground')}>
          {summarize(rule)}
        </span>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground'>
          <code className='font-mono'>{rule.cron}</code>
          {!valid ? (
            <span className='inline-flex items-center gap-0.5 text-destructive'>
              <XCircle className='size-3' />
              invalid
            </span>
          ) : null}
          {next ? (
            <span className='inline-flex items-center gap-0.5'>
              <Clock className='size-3' />
              {formatRunTime(next)}
            </span>
          ) : null}
        </div>
      </div>
      <div className='flex shrink-0 items-center gap-0.5'>
        <IconButton label='Edit schedule' onClick={onEdit}>
          <Pencil className='size-3' />
        </IconButton>
        <IconButton label='Delete schedule' destructive onClick={onDelete}>
          <Trash2 className='size-3' />
        </IconButton>
      </div>
    </div>
  )
}

// The live cron reflection: raw expression, human reading, validity, and the
// next few runs — all derived inside the component from the cron string.
function CronReflection({ cron }: { cron: string }) {
  const valid = validateCron(cron)
  const readable = valid ? humanizeCron(cron) : null
  const runs = valid ? nextRuns(cron, 3, Date.now()) : []
  return (
    <div className='flex flex-col gap-1.5 rounded-md border bg-muted/30 p-2'>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
        <code className={cn('font-mono text-[11px]', valid ? 'text-foreground' : 'text-destructive')}>{cron || '—'}</code>
        <span
          className={cn('inline-flex items-center gap-0.5 text-[11px]', valid ? 'text-green-600' : 'text-destructive')}
        >
          {valid ? <CheckCircle2 className='size-3' /> : <XCircle className='size-3' />}
          {valid ? 'valid' : 'invalid'}
        </span>
      </div>
      {readable ? <p className='text-[11px] text-muted-foreground'>{readable}</p> : null}
      {runs.length > 0 ? (
        <div className='flex flex-col gap-0.5'>
          <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>Next runs</span>
          {runs.map((d, i) => (
            <span key={i} className='inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground'>
              <Clock className='size-3' />
              {formatRunTime(d)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ScheduleEditor({
  editor,
  onChange,
  onSave,
  onCancel,
}: {
  editor: EditorState
  onChange: (next: EditorState) => void
  onSave: () => void
  onCancel: () => void
}) {
  const set = (patch: Partial<EditorState>) => onChange({ ...editor, ...patch })
  const cron = editor.mode === 'simple' ? buildCron(editor) : editor.cron
  const valid = validateCron(cron)
  const toggleDay = (day: string) =>
    set({ weekdays: editor.weekdays.includes(day) ? editor.weekdays.filter((d) => d !== day) : [...editor.weekdays, day] })

  return (
    <div className='flex flex-col gap-2 rounded-md border p-2'>
      <div className='flex items-center justify-between'>
        <SectionLabel>{editor.editingId ? 'Edit schedule' : 'New schedule'}</SectionLabel>
        <IconButton label='Cancel' onClick={onCancel}>
          <X className='size-3' />
        </IconButton>
      </div>

      <Tabs value={editor.mode} onValueChange={(v) => set({ mode: v as ScheduleMode })}>
        <TabsList className='h-7 w-full'>
          <TabsTrigger value='simple' className='text-[11px]'>
            Simple
          </TabsTrigger>
          <TabsTrigger value='cron' className='text-[11px]'>
            Cron
          </TabsTrigger>
        </TabsList>

        <TabsContent value='simple' className='mt-2 flex flex-col gap-2'>
          <div className='flex items-center gap-1.5'>
            <span className='shrink-0 text-muted-foreground'>Every</span>
            <Input
              type='number'
              min={1}
              value={editor.every}
              onChange={(e) => set({ every: e.target.value === '' ? 1 : Number(e.target.value) })}
              className='h-7 w-14 text-[11px]'
            />
            <Select value={editor.unit} onValueChange={(v) => set({ unit: v as ScheduleUnit })}>
              <SelectTrigger className='h-7 w-24 text-[11px]'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='minutes'>minutes</SelectItem>
                <SelectItem value='hours'>hours</SelectItem>
                <SelectItem value='days'>days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {editor.unit === 'days' ? (
            <>
              <div className='flex flex-col gap-1'>
                <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>On days</span>
                <div className='flex flex-wrap gap-1'>
                  {WEEKDAYS.map((day) => {
                    const active = editor.weekdays.includes(day)
                    return (
                      <button
                        key={day}
                        type='button'
                        aria-pressed={active}
                        onClick={() => toggleDay(day)}
                        className={cn(
                          'h-6 rounded-md px-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className='flex items-center gap-1.5'>
                <span className='shrink-0 text-muted-foreground'>At</span>
                <Input
                  value={editor.atTime}
                  onChange={(e) => set({ atTime: e.target.value })}
                  placeholder='09:00'
                  className='h-7 w-20 text-[11px]'
                />
              </div>
            </>
          ) : null}

          <CronReflection cron={cron} />
        </TabsContent>

        <TabsContent value='cron' className='mt-2 flex flex-col gap-2'>
          <div className='flex flex-col gap-1'>
            <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>Cron expression</span>
            <Input
              value={editor.cron}
              onChange={(e) => set({ cron: e.target.value })}
              placeholder='*/30 * * * *'
              className={cn(
                'h-7 font-mono text-[11px]',
                !valid && 'border-destructive focus-visible:ring-destructive',
              )}
            />
          </div>
          <CronReflection cron={cron} />
        </TabsContent>
      </Tabs>

      <div className='flex items-center justify-end gap-1.5'>
        <Button size='sm' variant='ghost' onClick={onCancel} className='h-7 text-[11px]'>
          Cancel
        </Button>
        <Button size='sm' onClick={onSave} disabled={!valid} className='h-7 text-[11px]'>
          Save
        </Button>
      </div>
    </div>
  )
}

function CombinedPreview({ upcoming, timezone }: { upcoming: UpcomingRun[]; timezone: string }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center justify-between gap-2'>
        <SectionLabel icon={<Clock className='size-3.5' />}>Next runs</SectionLabel>
        <Badge variant='secondary' className='text-[10px] font-normal'>
          Server: {timezone}
        </Badge>
      </div>
      {upcoming.length === 0 ? (
        <EmptyHint>No upcoming runs.</EmptyHint>
      ) : (
        <div className='flex flex-col'>
          {upcoming.map((run) => (
            <div key={run.id} className='flex items-baseline gap-2 border-b border-border py-1 last:border-b-0'>
              <span className='shrink-0 font-mono text-[11px] text-foreground'>{run.time}</span>
              {run.ruleSummary ? (
                <span className='truncate text-[11px] text-muted-foreground'>{run.ruleSummary}</span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RunHistory({ entries }: { entries: RunHistoryEntry[] }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <SectionLabel icon={<History className='size-3.5' />}>Run history</SectionLabel>
      {entries.length === 0 ? (
        <EmptyHint>No runs yet.</EmptyHint>
      ) : (
        <div className='flex flex-col'>
          {entries.map((entry) => (
            <RunHistoryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}

function RunHistoryRow({ entry }: { entry: RunHistoryEntry }) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean((entry.status === 'error' || entry.status === 'timeout') && entry.error)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className='flex items-center gap-2 py-1'>
        <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[entry.status])} />
        <span className='shrink-0 font-mono text-[11px] text-foreground'>{entry.time}</span>
        <span className='text-[11px] capitalize text-muted-foreground'>{STATUS_LABEL[entry.status]}</span>
        {entry.duration ? (
          <span className='ml-auto shrink-0 text-[11px] text-muted-foreground'>{entry.duration}</span>
        ) : null}
        {expandable ? (
          <CollapsibleTrigger asChild>
            <button
              type='button'
              aria-label='Show error detail'
              className='inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground'
            >
              <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            </button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      {expandable ? (
        <CollapsibleContent>
          <pre className='mb-1 ml-4 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-1.5 text-[11px] text-destructive'>
            {entry.error}
          </pre>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}
