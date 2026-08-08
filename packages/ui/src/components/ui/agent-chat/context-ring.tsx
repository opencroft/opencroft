'use client'

import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface ContextRingProps {
  // Tokens consumed so far.
  usedTokens: number
  // The context window's total size. Not every adapter reports one -- when it
  // is 0 or unset the ring reads as 0% and the popover shows the used count
  // alone, rather than a fraction of a window nobody knows. So a 0% ring means
  // "no window reported" as well as "nothing used"; the popover is what
  // distinguishes them, which is one more reason it exists.
  contextLimit: number
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

  const state = pct >= dangerAtPercent ? 'danger' : pct >= warnAtPercent ? 'warning' : 'default'
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
  const ariaLabel = compacting ? `${label} — compacting` : label

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
            className,
          )}
        >
          <svg className='pointer-events-none absolute inset-0 size-7 -rotate-90' viewBox='0 0 24 24'>
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
        </div>
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
