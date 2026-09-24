'use client'

import { Calendar as CalendarIcon, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

import { SegmentedButton } from 'ui/components/experimental/segmented-button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'ui/components/ui/alert-dialog'
import { Button } from 'ui/components/ui/button'
import { Calendar } from 'ui/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'ui/lib/utils'

export type UsageGrouping = 'all' | 'agent' | 'model'

export type UsagePeriod =
  | { kind: 'today' }
  | { kind: '7d' }
  | { kind: '30d' }
  /** The picked bounds ride as UTC day strings; either end is absent while the reader is still choosing. */
  | { kind: 'custom'; from?: string; to?: string }

export interface SpaceUsagePoint {
  /**
   * The bucket's start on the time axis, at whatever resolution the host
   * bucketed the window: a UTC day such as `2026-03-07`, or a UTC hour such
   * as `2026-03-07T14` for a window short enough to read by the hour. A day
   * is labelled as that day; an hour is labelled in the reader's own clock.
   */
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * What this bucket cost — the bucket's OWN spend, never a running total.
   * Harnesses report cost cumulatively per session, so the host differences
   * consecutive readings before it buckets; a cumulative figure passed here
   * would draw a chart that only ever climbs. Absent when the harness does
   * not price sessions at all.
   */
  cost?: number
}

export interface SpaceUsageSeries {
  key: string
  label: string
  points: SpaceUsagePoint[]
}

export interface SpaceUsageProps {
  /**
   * One series when grouping is `all`, one per agent or per model otherwise —
   * at most five (fold the rest into an "Other" series before passing; a
   * sixth line would need a colour the categorical set does not have). Every
   * series must share one date axis: same buckets, same order. Colour is
   * assigned by position, so keep the array order stable across refetches —
   * a filter that reorders survivors repaints them, and a repainted series
   * reads as a different entity.
   */
  series: SpaceUsageSeries[]
  grouping: UsageGrouping
  onGroupingChange: (grouping: UsageGrouping) => void
  /**
   * The reporting window. Same contract as the grouping: the choice leaves
   * as a callback and the host comes back with different rows — the
   * component never filters points itself, and it draws the buckets at
   * whatever resolution they come back in (see SpaceUsagePoint.date).
   */
  period: UsagePeriod
  onPeriodChange: (period: UsagePeriod) => void
  /**
   * Wipes the accounting behind the window shown. The reader confirms here;
   * the host deletes the rows and comes back with the (now empty) series, the
   * same round trip a period change makes — the component removes nothing
   * itself. The period is handed back rather than read off state so the host
   * deletes exactly what the reader was looking at. Absent, no reset control
   * is drawn: a host whose reader may not destroy the record simply does not
   * pass it.
   */
  onReset?: (period: UsagePeriod) => void | Promise<void>
  /** ISO currency code for the cost figures. */
  currency?: string
  className?: string
}

// The categorical set, in fixed order. Position five is the last one there is:
// an overflowing series list reuses it, visibly, which is the design telling
// the host to fold instead of the chart inventing a hue.
const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

function seriesColor(index: number): string {
  return SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)]
}

// Compact token counts — 18k, 680k, 1M, 2B — k / M / B / T covers any total a
// day of cache reads can reach. One decimal while the figure is small in its
// unit, dropped once it is noise. Same ladder and the same lower-case `k` the
// chat's own token readouts use (usage-cost, context-ring), so one quantity
// never renders two ways across the app.
function formatTokens(n: number): string {
  const value = Math.max(0, n)
  if (value >= 1e12) return `${trimTrailingZero((value / 1e12).toFixed(value >= 1e13 ? 0 : 1))}T`
  if (value >= 1e9) return `${trimTrailingZero((value / 1e9).toFixed(value >= 1e10 ? 0 : 1))}B`
  if (value >= 1e6) return `${trimTrailingZero((value / 1e6).toFixed(value >= 1e7 ? 0 : 1))}M`
  if (value >= 1e3) return `${trimTrailingZero((value / 1e3).toFixed(value >= 1e5 ? 0 : 1))}k`
  return String(Math.round(value))
}

// The smallest "nice" step — 1, 2 or 5 times a power of ten — whose fifth
// multiple reaches the maximum. Five levels at that step are the chart's
// horizontal scale: every level reads as a round figure (2M 4M 6M 8M 10M,
// never 1.37M), and the top one always contains the data.
function niceStep(max: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(max, 1) / 5))
  for (const m of [1, 2, 5]) {
    const step = m * magnitude
    if (step * 5 >= max) {
      return step
    }
  }
  return 10 * magnitude
}

function trimTrailingZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

function formatCost(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
}

// Level labels drop the cents a round figure does not have; a card's own sum
// keeps them, because a sum is a measurement and a level is a scale mark.
function formatCostTick(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
}

// "Mar 7" from a UTC day string; anything unparsable renders as itself, so a
// host bucketing by something other than days still gets its labels shown.
function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const HOUR_BUCKET = /^\d{4}-\d{2}-\d{2}T\d{2}$/

// A bucket start as its axis label. A day stays the UTC day it names; an
// hour is shown in the reader's own clock — "Mar 7, 14:00" — because an hour
// is the resolution at which the zone stops being noise and starts being the
// difference between lunch and midnight.
function formatBucket(bucket: string): string {
  if (!HOUR_BUCKET.test(bucket)) {
    return formatDay(bucket)
  }
  const parsed = new Date(`${bucket}:00:00Z`)
  return Number.isNaN(parsed.getTime())
    ? bucket
    : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// The period as it reads inside a sentence — "Reset usage for the last 7
// days?" — so a confirmation names the very window the switch is showing.
function periodLabel(period: UsagePeriod): string {
  switch (period.kind) {
    case 'today':
      return 'today'
    case '7d':
      return 'the last 7 days'
    case '30d':
      return 'the last 30 days'
    case 'custom':
      return period.from && period.to ? `${formatDay(period.from)} – ${formatDay(period.to)}` : 'this range'
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Day strings cross the component's boundary; Date objects live only inside
// the calendar. The conversion is local-time on both legs, so picking a day
// never shifts it across midnight.
function toDay(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function fromDay(day?: string): Date | undefined {
  if (!day) {
    return undefined
  }
  const parsed = new Date(`${day}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

interface ChartSeries {
  label: string
  color: string
  values: (number | undefined)[]
}

function linePoints(values: (number | undefined)[], x: (i: number) => number, y: (v: number) => number): string {
  const pts: string[] = []
  values.forEach((v, i) => {
    if (v !== undefined) {
      pts.push(`${x(i)},${y(v)}`)
    }
  })
  return pts.join(' ')
}

// One small-multiple: the metric's name and its period sum in the header,
// thin 2px lines over five evenly spaced, labelled levels at a computed
// round step (see niceStep), and a crosshair that follows the
// pointer — a vertical guide, a ringed dot per series, and a tooltip naming
// the bucket and each value. The whole plot is the hit target, so no mark
// needs to be hit precisely. Text stays in the ink tokens throughout; the
// line is the only thing wearing the series colour.
//
// The SVG stretches (its viewBox is a unit square), so nothing round or
// text-shaped lives inside it: strokes survive via non-scaling-stroke, and
// the dots and labels are HTML positioned by the same percentages — a circle
// drawn in the stretched space would render as an ellipse.
function ChartCard({
  title,
  total,
  dates,
  series,
  format,
  tickFormat,
}: {
  title: string
  /** The metric's period sum, already formatted — the card's headline figure. */
  total: string
  dates: string[]
  series: ChartSeries[]
  format: (value: number) => string
  /** Formats the level labels; the value format stands in when absent. */
  tickFormat?: (value: number) => string
}) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const n = dates.length
  const defined = series.flatMap((s) => s.values.filter((v): v is number => v !== undefined))
  const empty = n === 0 || defined.length === 0
  const max = Math.max(1, ...defined)
  const step = niceStep(max)
  // The scale's top is the fifth level, not the data's own maximum — round
  // levels are what make a value readable off the grid, and a maximum that
  // lands between levels keeps its headroom naturally.
  const yMax = step * 5
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const y = (v: number) => 100 - (v / yMax) * 100
  // A one-bucket series has no line to draw, so its dots stand permanently;
  // with more buckets the dots belong to the crosshair alone.
  const marker = hover ?? (n === 1 ? 0 : null)
  // One polyline string per series — the single-series fill below closes the
  // same path it draws, so it reads its own rather than building it twice.
  const paths = series.map((s) => linePoints(s.values, x, y))

  return (
    <div className='flex flex-col gap-3 rounded-lg border border-border p-4'>
      {/* The metric's name where it has always been, its period sum opposite
          it on the same line. One row rather than a stacked pair: the name is
          short and the figure is short, and stacking them spends a second
          line on the header while leaving the right half of every card empty.
          Baseline-aligned, so the small name and the large figure sit on one
          line instead of centring against each other. xl rather than 2xl —
          six cards carry one each, so it is this chart's figure and not one
          hero number for the page. */}
      <div className='flex items-baseline justify-between gap-3'>
        <span className='text-sm font-medium'>{title}</span>
        <span className='text-xl font-semibold tabular-nums'>{total}</span>
      </div>
      {empty ? (
        <div className='flex h-32 items-center justify-center text-xs text-muted-foreground'>Not reported</div>
      ) : (
        <div className='flex flex-col gap-1'>
          <div
            ref={plotRef}
            className='relative h-32 border-b border-border'
            onPointerMove={(event) => {
              const rect = plotRef.current?.getBoundingClientRect()
              if (!rect || rect.width === 0) {
                return
              }
              const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
              setHover(n <= 1 ? 0 : Math.round(frac * (n - 1)))
            }}
            onPointerLeave={() => setHover(null)}
          >
            <svg
              aria-hidden='true'
              className='absolute inset-0 size-full'
              viewBox='0 0 100 100'
              preserveAspectRatio='none'
            >
              {[1, 2, 3, 4, 5].map((k) => (
                <line
                  key={k}
                  x1='0'
                  y1={100 - k * 20}
                  x2='100'
                  y2={100 - k * 20}
                  stroke='var(--border)'
                  strokeDasharray='2 3'
                  vectorEffect='non-scaling-stroke'
                />
              ))}
              {series.length === 1 && n > 1 ? (
                <polygon points={`0,100 ${paths[0]} 100,100`} fill={series[0].color} fillOpacity='0.1' />
              ) : null}
              {series.map((s, i) => (
                <polyline
                  key={s.label}
                  points={paths[i]}
                  fill='none'
                  stroke={s.color}
                  strokeWidth='2'
                  strokeLinejoin='round'
                  strokeLinecap='round'
                  vectorEffect='non-scaling-stroke'
                />
              ))}
            </svg>
            {[1, 2, 3, 4, 5].map((k) => (
              <span
                key={k}
                aria-hidden='true'
                className='absolute right-0 text-[10px] leading-none tabular-nums text-muted-foreground'
                style={{ top: `calc(${100 - k * 20}% + 2px)` }}
              >
                {(tickFormat ?? format)(step * k)}
              </span>
            ))}
            {hover !== null ? (
              <div
                aria-hidden='true'
                className='absolute inset-y-0 w-px bg-foreground/20'
                style={{ left: `${x(hover)}%` }}
              />
            ) : null}
            {marker !== null
              ? series.map((s) => {
                  const v = s.values[marker]
                  if (v === undefined) {
                    return null
                  }
                  return (
                    <div
                      key={s.label}
                      aria-hidden='true'
                      className='absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background'
                      style={{ left: `${x(marker)}%`, top: `${y(v)}%`, backgroundColor: s.color }}
                    />
                  )
                })
              : null}
            {hover !== null ? (
              <div
                className='pointer-events-none absolute top-1 z-10 flex -translate-x-1/2 flex-col gap-0.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md'
                style={{ left: `clamp(3.5rem, ${x(hover)}%, calc(100% - 3.5rem))` }}
              >
                <span className='text-muted-foreground'>{formatBucket(dates[hover])}</span>
                {series.map((s) => {
                  const v = s.values[hover]
                  if (v === undefined) {
                    return null
                  }
                  return (
                    <span key={s.label} className='flex items-center gap-1.5 whitespace-nowrap tabular-nums'>
                      {series.length > 1 ? (
                        <span aria-hidden='true' className='size-1.5 rounded-full' style={{ backgroundColor: s.color }} />
                      ) : null}
                      {series.length > 1 ? <span className='text-muted-foreground'>{s.label}</span> : null}
                      <span className='font-medium'>{format(v)}</span>
                    </span>
                  )
                })}
              </div>
            ) : null}
          </div>
          <div className='flex justify-between text-[10px] text-muted-foreground'>
            <span>{formatBucket(dates[0])}</span>
            {n > 1 ? <span>{formatBucket(dates[n - 1])}</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}

// The usage page for a space's settings: what was spent, then how it moved.
//
// The reading order is the design, and it lives inside each card: the
// metric's period sum stands in the card's header, in the largest type on
// the page, directly over the curve that produced it — so a figure has its
// number before it has its shape, and the number is ON the chart it belongs
// to rather than in a separate row the reader has to match back. Six of
// them: cost and totals, then the decomposition — input and output, cache
// reads and writes — that explains where token counts of that size come
// from. Separate single-axis charts rather than anything
// combined: tokens and currency do not share a scale, and a second y-axis
// is how one chart lies twice.
//
// The grouping switch redraws the whole page, not one chart. All, per agent
// and per model are different queries over the same records, so the choice
// leaves as a callback and the host comes back with different series — this
// component never aggregates, splits, or differences anything. Colour then
// follows the series across every chart on the page: whichever line Ada is
// in the tokens chart, she is in the cost chart too, named once in the one
// legend all four share.
//
// The reset control is the one thing on the page that writes, and it writes
// through the same door everything reads: it asks, then hands the period to
// the host, and the host comes back with the series the way it does after
// any other switch. Drawn only when a host offers it.
export function SpaceUsage({
  series,
  grouping,
  onGroupingChange,
  period,
  onPeriodChange,
  onReset,
  currency = 'USD',
  className,
}: SpaceUsageProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const dates = series[0]?.points.map((p) => p.date) ?? []
  const coloured = series.map((s, i) => ({ ...s, color: seriesColor(i) }))

  const totalOf = (metric: (p: SpaceUsagePoint) => number) =>
    series.reduce((sum, s) => sum + s.points.reduce((a, p) => a + metric(p), 0), 0)
  // Cost is the one optional metric: unreported everywhere means the harnesses
  // behind this window do not price sessions, which reads as a dash — a 0 would
  // claim the window was free.
  const hasCost = series.some((s) => s.points.some((p) => p.cost !== undefined))
  const totalCost = totalOf((p) => p.cost ?? 0)

  const chartSeries = (metric: (p: SpaceUsagePoint) => number | undefined): ChartSeries[] =>
    coloured.map((s) => ({ label: s.label, color: s.color, values: s.points.map(metric) }))

  // A half-picked custom range names no window, so there is nothing yet to
  // confirm wiping; an empty window has nothing to wipe at all.
  const bounded = period.kind !== 'custom' || Boolean(period.from && period.to)
  const handleReset = async () => {
    if (!onReset) {
      return
    }
    setResetting(true)
    try {
      await onReset(period)
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Both switches read the whole page — the period picks the rows, the
          grouping picks the series — so they stand above everything they
          redraw. The legend gets its own line beneath them: it spans every
          chart, and repeating it per card would say the same names six
          times. */}
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <SegmentedButton
            size='sm'
            value={period.kind}
            // Re-picking the period already showing would hand the host a new
            // object describing the same window, and every period change costs
            // it a query — so the no-op stays a no-op. That also means the only
            // way into `custom` is from another period, with both ends unpicked.
            onChange={(kind) => {
              if (kind !== period.kind) {
                onPeriodChange({ kind })
              }
            }}
            options={[
              { value: 'today', label: 'Today' },
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          {period.kind === 'custom' ? (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger render={<Button type='button' variant='outline' size='sm' className='gap-1.5 font-normal' />}>
                <CalendarIcon aria-hidden='true' className='size-3.5' />
                {period.from && period.to
                  ? `${formatDay(period.from)} – ${formatDay(period.to)}`
                  : period.from
                    ? `${formatDay(period.from)} – …`
                    : 'Pick dates'}
              </PopoverTrigger>
              <PopoverContent align='start' className='w-auto p-0'>
                {/* Opens on the data's own month rather than the calendar's
                    idea of now, so the reader lands where the rows are — the
                    last bucket's day, whatever resolution it came in at. The
                    popover dismisses itself once both ends are picked. */}
                <Calendar
                  mode='range'
                  defaultMonth={fromDay(period.from) ?? fromDay(dates[dates.length - 1]?.slice(0, 10))}
                  selected={{ from: fromDay(period.from), to: fromDay(period.to) }}
                  onSelect={(range) => {
                    onPeriodChange({
                      kind: 'custom',
                      ...(range?.from ? { from: toDay(range.from) } : {}),
                      ...(range?.to ? { to: toDay(range.to) } : {}),
                    })
                    if (range?.from && range.to) {
                      setPickerOpen(false)
                    }
                  }}
                />
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <SegmentedButton
            size='sm'
            value={grouping}
            onChange={onGroupingChange}
            options={[
              { value: 'all', label: 'All' },
              { value: 'agent', label: 'Per agent' },
              { value: 'model', label: 'Per model' },
            ]}
          />
          {onReset ? (
            // Quiet in the row — an outline in the destructive ink, not a
            // filled red button standing beside two switches — because the
            // confirmation beneath is what carries the weight of the act.
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='gap-1.5 font-normal text-destructive hover:text-destructive'
              disabled={dates.length === 0 || !bounded || resetting}
              onClick={() => setResetOpen(true)}
            >
              <Trash2 aria-hidden='true' className='size-3.5' />
              Reset
            </Button>
          ) : null}
        </div>
      </div>
      {coloured.length > 1 ? (
        <div className='flex flex-wrap items-center gap-3'>
          {coloured.map((s) => (
            <span key={s.key} className='flex items-center gap-1.5 text-xs text-muted-foreground'>
              <span aria-hidden='true' className='size-2 rounded-full' style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      {dates.length === 0 ? (
        <div className='flex h-40 items-center justify-center text-sm text-muted-foreground'>
          No usage recorded yet
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-2'>
          <ChartCard
            title='Cost'
            total={hasCost ? formatCost(totalCost, currency) : '—'}
            dates={dates}
            series={chartSeries((p) => p.cost)}
            format={(v) => formatCost(v, currency)}
            tickFormat={(v) => formatCostTick(v, currency)}
          />
          <ChartCard
            title='Total tokens'
            total={formatTokens(totalOf((p) => p.totalTokens))}
            dates={dates}
            series={chartSeries((p) => p.totalTokens)}
            format={formatTokens}
          />
          <ChartCard
            title='Input tokens'
            total={formatTokens(totalOf((p) => p.inputTokens))}
            dates={dates}
            series={chartSeries((p) => p.inputTokens)}
            format={formatTokens}
          />
          <ChartCard
            title='Output tokens'
            total={formatTokens(totalOf((p) => p.outputTokens))}
            dates={dates}
            series={chartSeries((p) => p.outputTokens)}
            format={formatTokens}
          />
          <ChartCard
            title='Cache reads'
            total={formatTokens(totalOf((p) => p.cacheReadTokens))}
            dates={dates}
            series={chartSeries((p) => p.cacheReadTokens)}
            format={formatTokens}
          />
          <ChartCard
            title='Cache writes'
            total={formatTokens(totalOf((p) => p.cacheWriteTokens))}
            dates={dates}
            series={chartSeries((p) => p.cacheWriteTokens)}
            format={formatTokens}
          />
        </div>
      )}
      {onReset ? (
        <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset usage for {periodLabel(period)}?</AlertDialogTitle>
              <AlertDialogDescription>
                Every turn recorded in this window is deleted — its cost and token figures go back to zero, and
                nothing brings them back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleReset()}>Reset</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}
