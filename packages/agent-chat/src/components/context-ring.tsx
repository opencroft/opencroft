'use client'

import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { UsageCost, type UsageTokens } from './usage-cost'

import { Button } from 'ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { Slider } from 'ui/components/ui/slider'
import { cn } from 'ui/lib/utils'

export interface ContextRingProps {
  // Tokens consumed so far.
  usedTokens: number
  // The context window's total size. Not every adapter reports one -- when it
  // is 0 or unset the ring reads as 0% and the popover shows the used count
  // alone, rather than a fraction of a window nobody knows. So a 0% ring means
  // "no window reported" as well as "nothing used"; the popover is what
  // distinguishes them, which is one more reason it exists.
  contextLimit: number
  // The session's cumulative cost, when the harness prices the session. Shown
  // in the popover, under the context counts -- the ring's own mark stays the
  // percentage, so one control keeps answering one question.
  sessionCost?: { amount: number; currency: string }
  // The session's token account so far -- total, input, output, cache reads
  // and writes -- when the host keeps one (summed from the turns it recorded).
  // Drawn with the cost as one block, the same block a subagent's step count
  // opens, so the session and its delegations account for themselves in one
  // shape. Absent counters draw as dashes, never zeros.
  sessionTokens?: UsageTokens
  // The account's subscription rate-limit windows, when the harness reports
  // them (Claude's five-hour and weekly limits, per model where it says so).
  // Each window renders its own line: how much of it is used, and when it
  // resets. Absent means the harness reports none -- never "all used up".
  rateLimits?: { status: string; window: string; utilization?: number; resetsAt?: number }[]
  // Wall-clock time (ms since epoch) this figure was reported. Present ONLY on a
  // last-known reading served for a session that is offline -- never on a live
  // one. Its presence dims the ring and adds a line to the popover naming when
  // the reading is from; its absence is the ordinary, fully-opaque ring.
  //
  // A reading with no `asOf` is therefore a claim about NOW, and one with an
  // `asOf` is a claim about then. The component draws the difference rather than
  // leaving a stale number looking current.
  asOf?: number
  // Where the ring stops being neutral, as PERCENTAGES -- the unit is in the
  // name because a fraction passed to a percentage prop fails silently: the
  // threshold is simply never crossed and the ring stays neutral at 99%.
  warnAtPercent?: number
  dangerAtPercent?: number
  // Compacts the conversation. Delegation, not notification: this component
  // cannot compact anything, so without a handler the button is not offered --
  // pressing it could only have done nothing.
  onCompact?: () => void
  // A compaction is running. The popover deliberately stays open through it
  // (see the note below), and this is what gives that decision something to
  // show; without it the press is silent and the panel just sits there.
  compacting?: boolean
  // What became of it, in the host's own words: an outcome ("Compacted --
  // 120,000 -> 30,000 tokens."), a nothing-to-do ("Nothing to compact"), or a
  // refusal that arrived as data rather than as a thrown error.
  //
  // Displayed and nothing more: this component does not know what compaction
  // did, cannot phrase it, and never clears it. It also does not gate the
  // Compact button -- what a message means for whether the action is still
  // available is the host's judgement, expressed through `compacting`.
  //
  // It is for OUTCOMES. The in-flight state is already on the button, so a
  // host that also puts "Compacting..." here says the same thing twice.
  statusMessage?: string
  // How the message reads. `destructive` for a failure or a refusal -- the one
  // case where the wording alone is not enough, because a refusal and a result
  // are the same shape of sentence in the same place.
  statusTone?: 'default' | 'destructive'
  // Discards the session and starts a fresh one. Delegation, exactly like
  // `onCompact`: this component cannot clear anything itself, so without a
  // handler the button is not offered.
  onClear?: () => void
  // Opens the popover on mount. For a doc page that needs to show the open
  // state, and for a host that wants the detail visible on first arrival.
  defaultOpen?: boolean
  className?: string
}

// Clear is destructive and irreversible (the old transcript is gone, not
// archived), so it never fires on the first press. The button asks once --
// its own label becomes the question -- and only a second press while still
// showing that question confirms it. Any other interaction (closing the
// popover, pressing Compact, moving focus away) drops back to the plain
// label rather than leaving a live "press again to destroy this" armed and
// forgotten.
function ClearButton({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false)

  return (
    <Button
      type='button'
      size='sm'
      variant={confirming ? 'destructive' : 'outline'}
      className='w-full'
      disabled={disabled}
      onBlur={() => setConfirming(false)}
      onClick={() => {
        if (confirming) {
          setConfirming(false)
          onClear()
        } else {
          setConfirming(true)
        }
      }}
    >
      {confirming ? 'Press again to clear' : 'Clear'}
    </Button>
  )
}

// Compact token counts -- 18k, 680k, 1M -- matching how the chat formats tokens
// elsewhere, so the same number does not appear in two shapes on one screen.
// The decimal is dropped once it is noise at the magnitude (100k+, 10M+), and a
// trailing ".0" is trimmed so a round million reads "1M" and not "1.0M".
function formatTokens(n: number): string {
  const value = Math.max(0, n)
  if (value >= 1000000) return `${trimTrailingZero((value / 1000000).toFixed(value >= 10000000 ? 0 : 1))}M`
  if (value >= 1000) return `${trimTrailingZero((value / 1000).toFixed(value >= 100000 ? 0 : 1))}k`
  return String(Math.round(value))
}

function trimTrailingZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

// "Reported just now" / "Reported 5m ago" / "Reported 3h ago", falling back to a
// short date once it is more than a day stale. Minute-then-hour-then-date is the
// granularity freshness copy usually wants: below a minute the exact figure is
// noise, and past a day the elapsed count stops meaning anything to read.
function formatAsOf(asOf: number): string {
  const diffMin = Math.round((Date.now() - asOf) / 60_000)
  if (diffMin < 1) return 'Reported just now'
  if (diffMin < 60) return `Reported ${diffMin}m ago`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `Reported ${diffHour}h ago`
  return `Reported ${new Date(asOf).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

// Human labels for the window names harnesses actually send; anything else
// falls back to the harness's own spelling, which is still readable.
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Opus weekly limit',
  seven_day_sonnet: 'Sonnet weekly limit',
  seven_day_fable: 'Fable weekly limit',
  overage: 'Extra usage',
}

// The one state rule for the ring AND the limit gauges, decided from the
// rounded percentage — never the raw fraction. Comparing the raw one would
// let a mark read "70" in the neutral colour (at 69.6%, which rounds up but
// has not crossed), and a number that reads as past the threshold while the
// colour says otherwise reads as a bug -- correctly, since one of the two
// would be lying.
function usageState(pct: number, warnAtPercent: number, dangerAtPercent: number): 'default' | 'warning' | 'danger' {
  return pct >= dangerAtPercent ? 'danger' : pct >= warnAtPercent ? 'warning' : 'default'
}

// One limit window: title and reset time on the left, the value on the
// right, and an inert slider gauge of the utilization beneath — the thumb
// hidden, no pointer, no focus, so what remains is the slider's filled
// track doing a bar's job. Both the thumb selectors that can ever match are
// spelled: the track's own data-slot spelling, and the ARIA role the Radix
// thumb always carries — a preview pool (or a consumer build) resolving an
// older slider without data-slot attributes would otherwise show a handle.
//
// Colour source, in order: the harness's OWN verdict on the window when it
// reports one (`rejected` → destructive, `allowed_warning` → warning), and
// otherwise the ring's warnAtPercent/dangerAtPercent thresholds, through
// the same state rule and the same rounded percentage the ring uses — so a
// window the harness merely says "allowed" about still turns amber exactly
// where the ring would. The text stays uncoloured either way: the bar is
// the colour channel. An unreported utilization draws no gauge at all
// rather than an empty one pretending to be a zero.
function RateLimitRow({
  limit,
  warnAtPercent,
  dangerAtPercent,
}: {
  limit: { status: string; window: string; utilization?: number; resetsAt?: number }
  warnAtPercent: number
  dangerAtPercent: number
}) {
  const pct = limit.utilization !== undefined ? Math.max(0, Math.min(100, Math.round(limit.utilization))) : null
  const state =
    limit.status === 'rejected'
      ? 'danger'
      : limit.status === 'allowed_warning'
        ? 'warning'
        : pct === null
          ? 'default'
          : usageState(pct, warnAtPercent, dangerAtPercent)
  const resets = limit.resetsAt
    ? ` resets ${new Date(limit.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : ''
  return (
    <div className='flex flex-col gap-1.5'>
      {/* Title and reset time left, value right; the gap keeps the two
          apart when a window name runs long. */}
      <div className='flex items-baseline justify-between gap-3'>
        <span className='text-xs text-muted-foreground'>
          <span className='font-medium'>{WINDOW_LABELS[limit.window] ?? limit.window}</span>
          {resets}
        </span>
        {pct !== null ? <span className='text-xs tabular-nums text-muted-foreground'>{pct}%</span> : null}
      </div>
      {/* A rejection with no reported utilization has no gauge to carry the
          state, and the value slot is too narrow beside a long window title —
          both halves wrapped there. Its own line instead, in the one colour
          that must not be missed, since there is no bar to wear it. */}
      {pct === null && limit.status === 'rejected' ? (
        <span className='text-xs text-destructive'>Limit reached</span>
      ) : null}
      {pct !== null ? (
        <Slider
          value={[pct]}
          min={0}
          max={100}
          aria-hidden='true'
          className={cn(
            'pointer-events-none [&_[data-slot=slider-thumb]]:hidden [&_[role=slider]]:hidden',
            state === 'danger'
              ? '[&_[data-slot=slider-range]]:bg-destructive'
              : state === 'warning'
                ? '[&_[data-slot=slider-range]]:bg-warning'
                : null,
          )}
        />
      ) : null}
    </div>
  )
}

// A circular context-usage indicator for an agent chat: the fraction of the
// window in use drawn as a ring, the integer percentage written in the centre,
// and the counts -- plus Compact -- in a popover on press.
//
// **Presentational.** It receives the two numbers and a callback; it computes
// the fraction and the state itself, and it fetches nothing and compacts
// nothing. Compact is where it is because that is where the decision to compact
// is made -- you look at the ring, and the thing you might want to do about
// what it says should be in the same place, not a separate button on the
// surface competing for room with the composer's own controls.
//
// **A popover, not a tooltip.** A tooltip is hover/focus-transient, so on touch
// it flashes and closes the moment the pointer leaves -- and it could never
// hold a button, because reaching one would dismiss it. A popover opens on
// press, stays until dismissed, and works the same with a mouse.
//
// **It stays open through the whole of a compaction, and that is what makes it
// a place a result can arrive.** Closing on the press would have made this a
// fire-and-forget button -- but compaction is an async job that can already be
// running when the panel opens, can finish with something worth reading, and
// can be refused outright. `compacting` covers the middle of that, and
// `statusMessage` covers the ends.
//
// **The colour and the number never disagree.** The state is decided from the
// SAME rounded percentage that is drawn in the centre, not from the raw
// fraction. Comparing the raw one would let the ring show "70" in the neutral
// colour (at 69.6%, which rounds up but has not crossed), and a number that
// reads as past the threshold while the colour says otherwise reads as a bug --
// correctly, since one of the two would be lying.
//
// **Colour is the second channel, not the only one.** The ring's fill is the
// first: a nearly-full circle is a different shape from a quarter-full one
// whatever its hue, and the percentage is written out besides. So the states
// survive being unable to tell the colours apart.
export function ContextRing({
  usedTokens,
  contextLimit,
  sessionCost,
  sessionTokens,
  rateLimits,
  asOf,
  warnAtPercent = 70,
  dangerAtPercent = 90,
  onCompact,
  compacting = false,
  statusMessage,
  statusTone = 'default',
  onClear,
  defaultOpen,
  className,
}: ContextRingProps) {
  const hasLimit = contextLimit > 0
  const ratio = hasLimit ? Math.min(1, Math.max(0, usedTokens / contextLimit)) : 0
  const pct = Math.round(ratio * 100)

  const state = usageState(pct, warnAtPercent, dangerAtPercent)
  const stroke =
    state === 'danger' ? 'var(--destructive)' : state === 'warning' ? 'var(--warning)' : 'var(--primary)'

  const radius = 9
  const circumference = 2 * Math.PI * radius
  const dash = circumference * ratio

  const counts = hasLimit
    ? `${formatTokens(usedTokens)} / ${formatTokens(contextLimit)}`
    : formatTokens(usedTokens)
  const label = hasLimit
    ? `Context usage: ${counts} (${pct}%)`
    : `Context usage: ${counts} used, window size not reported`
  const freshness = asOf ? formatAsOf(asOf) : null
  // The freshness reaches the accessible name too: the dimming is the visual
  // channel for it and a screen reader has no access to that one, so without
  // this a last-known reading would be announced as a current one.
  const ariaLabel = compacting ? `${label} — compacting` : freshness ? `${label} — ${freshness}` : label

  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={ariaLabel}
          className={cn(
            // A real target: it is pressable, so it says so on hover and takes
            // focus visibly. Same footprint as before -- the disc sits inside
            // the space the ring already occupied, so nothing around it moves.
            'relative inline-flex size-7 items-center justify-center rounded-full outline-none transition-colors',
            'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
            // A last-known reading, not a live one. De-emphasis rather than a
            // separate treatment, so it reads as the same control in a quieter
            // state -- and it reverts the instant a live reading replaces it.
            asOf ? 'opacity-60' : null,
            className,
          )}
        >
          {/* Decorative. The button already carries the reading as its
              accessible name, so leaving the ring announceable would say the
              same thing twice.

              Spelled `aria-hidden='true'` rather than bare: the two are the
              same attribute once React renders them, but the a11y lint only
              recognises the explicit form and reads the bare one as no
              annotation at all. */}
          <svg aria-hidden='true' className='pointer-events-none absolute inset-0 size-7 -rotate-90' viewBox='0 0 24 24'>
            <circle cx='12' cy='12' r={radius} fill='none' strokeWidth='2.5' style={{ stroke: 'var(--border)' }} />
            <circle
              cx='12'
              cy='12'
              r={radius}
              fill='none'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeDasharray={`${dash} ${circumference - dash}`}
              style={{ stroke }}
            />
          </svg>
          {/* The numeral follows the ring only into danger. Warning is an amber
              token, and amber text at 10px is a contrast problem rather than a
              signal -- the ring itself carries that state, where a 2.5px stroke
              against the track has the contrast to spare. */}
          {compacting ? (
            // The ring's own loader, in place of the numerals -- reusing the
            // spinner compaction already shows elsewhere rather than adding a
            // second one. The fill keeps drawing the pre-compaction usage
            // underneath it, so the ring itself never goes blank.
            <Loader2 aria-hidden className='pointer-events-none relative size-3 animate-spin text-muted-foreground' />
          ) : (
            <span
              className={cn(
                'pointer-events-none relative tabular-nums',
                state === 'danger' ? 'font-medium text-destructive' : 'text-muted-foreground',
              )}
              style={{ fontSize: 10 }}
            >
              {pct}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' side='top' className='w-56 p-0'>
        <div className='flex flex-col gap-0.5 p-3'>
          <span className='text-xs text-muted-foreground'>Context</span>
          <span
            className={cn(
              'text-sm font-medium tabular-nums',
              state === 'danger' ? 'text-destructive' : 'text-foreground',
            )}
          >
            {counts}
          </span>
          <span className='text-xs text-muted-foreground'>
            {hasLimit ? `${pct}% of the window used` : 'Window size not reported'}
          </span>
          {/* Only on a last-known reading. The dimmed ring says something is
              off about this figure; this is the line that says what. */}
          {freshness ? <span className='text-xs text-muted-foreground'>{freshness}</span> : null}
        </div>
        {sessionCost || sessionTokens ? (
          <div className='border-t border-border p-3'>
            <UsageCost cost={sessionCost} tokens={sessionTokens} />
          </div>
        ) : null}
        {rateLimits && rateLimits.length > 0 ? (
          <div className='flex flex-col gap-1 border-t border-border p-3'>
            <span className='text-xs text-muted-foreground'>Usage limits</span>
            {/* Stable across re-renders and unique per line: a harness sends
                one reading per window, and the window is what distinguishes
                them. */}
            {rateLimits.map((limit) => (
              <RateLimitRow
                key={limit.window}
                limit={limit}
                warnAtPercent={warnAtPercent}
                dangerAtPercent={dangerAtPercent}
              />
            ))}
          </div>
        ) : null}
        {onCompact || onClear ? (
          // Full width and stacked under a rule: these are the actions here,
          // and tucking one beside the numbers it is about reads as a
          // footnote to them rather than as the thing you came to press.
          <div className='flex flex-col gap-2 border-t border-border p-2'>
            {onCompact ? (
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='w-full'
                onClick={onCompact}
                disabled={compacting}
              >
                {compacting ? 'Compacting…' : 'Compact'}
              </Button>
            ) : null}
            {onClear ? (
              // Disabled mid-compaction too -- clearing the session out from
              // under a running compaction is the same hazard Compact's own
              // disablement already guards against, just from the other button.
              <ClearButton onClear={onClear} disabled={compacting} />
            ) : null}
          </div>
        ) : null}

        {/* Under the action row, and ALWAYS rendered -- it is the panel's live
            region, and a role='status' element spliced in at the moment its
            text appears is announced unreliably or not at all. The panel's
            content mounts when it opens, so the region is in place before an
            outcome can arrive. With nothing to say it carries no border and no
            padding, and costs no height.

            It WRAPS rather than truncates: this is prose the host wrote, and
            the end of a refusal is the half that says why. */}
        <div
          role='status'
          aria-live='polite'
          className={cn('text-xs', statusMessage ? 'border-t border-border px-3 py-2' : null)}
        >
          {statusMessage ? (
            <span
              className={cn(
                'wrap-break-word',
                statusTone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {statusMessage}
            </span>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
