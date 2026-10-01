'use client'

import { Check, Copy, TriangleAlert } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { cn } from 'cn'

export interface ApiTokenRevealProps {
  // The secret, shown once. The host feeds it in from the create call; this
  // component never fetches or generates it.
  token: string
  // The name the host created the token under, for context. Optional.
  tokenName?: string
  // The host says the copy succeeded. Flips the copy button to a confirmed
  // state -- the component itself never touches the clipboard.
  copied?: boolean
  // The user asked to copy. The host performs the clipboard write and reports
  // back through `copied`.
  onCopy: () => void
  // The user is done -- they have what they need and are moving on. After this
  // the host treats the secret as gone; this component does not enforce that,
  // it only reports the click.
  onDone: () => void
  className?: string
}

// The one-time secret reveal: the moment a new token's value is shown and then
// never again. The whole problem is making "copy this now or lose it"
// unmissable without screaming -- so the panel is amber (caution), not red
// (alarm), the warning says plainly that the token cannot be recovered, and
// Copy is the obvious primary act while Done is the quiet secondary one. There
// is no hard gate: the host decides what "done" costs.
//
// Presentation only. The token arrives as a prop; copy and done leave as
// callbacks, and the clipboard is the host's, not this component's.
export function ApiTokenReveal({
  token,
  tokenName,
  copied,
  onCopy,
  onDone,
  className,
}: ApiTokenRevealProps) {
  return (
    <div className={cn('rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 sm:p-5', className)}>
      <div className='flex items-start gap-3'>
        <TriangleAlert className='mt-0.5 size-5 shrink-0 text-amber-600' aria-hidden='true' />
        <div className='min-w-0 flex-1'>
          <h2 className='text-sm font-semibold'>
            {tokenName ? <>Your token “{tokenName}” is ready</> : 'Your new token is ready'}
          </h2>
          <p className='mt-1 text-sm text-muted-foreground'>
            Copy it now.{' '}
            <span className='font-medium text-foreground'>You will not be able to see it again</span>{' '}
            — if you lose it you will have to revoke this token and create a new one.
          </p>
        </div>
      </div>

      <div className='mt-4 flex flex-col gap-2 sm:flex-row sm:items-stretch'>
        <code className='min-w-0 flex-1 select-all break-all rounded-md bg-background/70 p-3 font-mono text-sm text-foreground'>
          {token}
        </code>
        <Button type='button' onClick={onCopy} className='sm:shrink-0'>
          {copied ? (
            <>
              <Check className='size-4' /> Copied
            </>
          ) : (
            <>
              <Copy className='size-4' /> Copy
            </>
          )}
        </Button>
      </div>

      <div className='mt-3'>
        <Button type='button' variant='outline' onClick={onDone} className='w-full sm:w-auto'>
          I&rsquo;ve copied my token
        </Button>
      </div>
    </div>
  )
}
