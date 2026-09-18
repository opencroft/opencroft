import { cn } from 'ui/lib/utils'

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

const COUNTERS: { key: keyof UsageTokens; label: string }[] = [
  { key: 'total', label: 'Total' },
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache reads' },
  { key: 'cacheWrite', label: 'Cache writes' },
]

// The label above its figure, the shape every cell in the block shares. The
// labels are short, so the cells run horizontally and wrap to the width they
// are given -- one line in a wide host, two or three in a popover -- rather
// than spending a tall label column on six one-word names.
function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex flex-col'>
      <span className='text-[10px] text-muted-foreground'>{label}</span>
      <span className='text-xs font-medium tabular-nums'>{value}</span>
    </div>
  )
}

// What a piece of work cost, in one shape wherever it is shown: a row of
// label-over-figure cells -- the money first, then the token account (total,
// input, output, cache reads, cache writes). The same block stands in the
// context ring's panel for the session and anywhere else a spend is opened,
// so no two surfaces say it two ways.
//
// A figure the harness did not report draws as a dash, never as a zero: an
// unpriced session is not a free one. With nothing reported at all the block
// says so in words rather than drawing a row of dashes.
export function UsageCost({ cost, tokens, className }: UsageCostProps) {
  const reported = cost !== undefined || COUNTERS.some(({ key }) => tokens?.[key] !== undefined)
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className='text-xs text-muted-foreground'>Costs</span>
      {reported ? (
        <div className='flex flex-wrap gap-x-4 gap-y-1.5'>
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
