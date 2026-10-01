import { cn } from 'cn'

/** The token account of a piece of work. Every counter is optional: a harness
 * that reports only a total leaves the rest absent, and absent draws as a dash. */
export interface UsageTokens {
  total?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface UsageCostProps {
  /** What it cost, when the harness prices the work at all. */
  cost?: { amount: number; currency: string }
  tokens?: UsageTokens
  className?: string
}

// Compact token counts -- 18k, 680k, 1M, 2B -- the shapes the chat uses
// elsewhere, so one number never appears in two forms on one screen. The
// decimal is dropped once it is noise at the magnitude, and a trailing ".0"
// is trimmed so a round million reads "1M" and not "1.0M".
function formatTokens(n: number): string {
  const value = Math.max(0, n)
  if (value >= 1e12) return `${trimTrailingZero((value / 1e12).toFixed(value >= 1e13 ? 0 : 1))}T`
  if (value >= 1e9) return `${trimTrailingZero((value / 1e9).toFixed(value >= 1e10 ? 0 : 1))}B`
  if (value >= 1e6) return `${trimTrailingZero((value / 1e6).toFixed(value >= 1e7 ? 0 : 1))}M`
  if (value >= 1e3) return `${trimTrailingZero((value / 1e3).toFixed(value >= 1e5 ? 0 : 1))}k`
  return String(Math.round(value))
}

function trimTrailingZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

function formatCost(cost: { amount: number; currency: string }): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: cost.currency }).format(cost.amount)
}

// Ordered for the three-column grid below rather than for reading: the grid
// fills row-major and `Cost` takes the first cell, so this list lands as the
// rest of row one and the whole of row two -- which is what pairs each
// column (cost over total, input over output, cache reads over cache
// writes). Sorting it back into reading order leaves the grid looking
// intact and scatters the pairs, which are the whole of what it says.
const COUNTERS: { key: keyof UsageTokens; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'cacheRead', label: 'Cache reads' },
  { key: 'total', label: 'Total' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite', label: 'Cache writes' },
]

// The label above its figure, the shape every cell in the block shares. Six
// one-word labels in a column beside their figures would spend the block's
// height on the names rather than on the numbers; stacked, a cell is two
// short lines and three of them stand on a row.
function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex flex-col'>
      <span className='text-[10px] text-muted-foreground'>{label}</span>
      <span className='text-xs font-medium tabular-nums'>{value}</span>
    </div>
  )
}

// What a piece of work cost, in one shape wherever it is shown: a grid of
// label-over-figure cells -- the money first, then the token account. The
// same block stands in the context ring's panel for the session and anywhere
// else a spend is opened, so no two surfaces say it two ways.
//
// Three columns, fixed, in two rows: the figures line up in columns the way
// wrapped cells never quite do, and the count is the same in a popover and
// in a full-width panel, so the block reads as one shape rather than as a
// layout that rearranges itself per host. Which figure sits above which is
// the COUNTERS order above, and it is load-bearing -- see the note there.
//
// A figure the harness did not report draws as a dash, never as a zero: an
// unpriced session is not a free one. With nothing reported at all the block
// says so in words rather than drawing a grid of dashes.
export function UsageCost({ cost, tokens, className }: UsageCostProps) {
  const reported = cost !== undefined || COUNTERS.some(({ key }) => tokens?.[key] !== undefined)
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className='text-xs text-muted-foreground'>Costs</span>
      {reported ? (
        <div className='grid grid-cols-3 gap-x-2 gap-y-1.5'>
          <Cell label='Cost' value={cost ? formatCost(cost) : '—'} />
          {COUNTERS.map(({ key, label }) => {
            const value = tokens?.[key]
            return <Cell key={key} label={label} value={value !== undefined ? formatTokens(value) : '—'} />
          })}
        </div>
      ) : (
        <span className='text-xs text-muted-foreground'>Not reported</span>
      )}
    </div>
  )
}
