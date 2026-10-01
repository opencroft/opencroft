'use client'

import { KeyRound } from 'lucide-react'

import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { cn } from 'cn'

export interface ApiToken {
  id: string
  name: string
  // Display-ready strings. The host formats them -- this component renders
  // them verbatim and decides nothing about locale or relative time.
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  // Status flags the host has already derived. Revoked tokens read as inert;
  // expired ones carry a caution badge. Both can be set; revoked wins.
  revoked?: boolean
  expired?: boolean
}

export interface ApiTokenListProps {
  tokens: ApiToken[]
  // The user asked to revoke a token. Confirmation is the host's -- this only
  // reports the request, and stays usable while the host asks "are you sure?".
  onRevoke: (tokenId: string) => void
  // A revoke is in flight for this token id: its button goes inert and says so.
  revokingTokenId?: string | null
  className?: string
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-baseline gap-1.5'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='text-foreground'>{value}</dd>
    </div>
  )
}

// The API token list, with no frame around it. Each row carries a token's name
// (and a status badge when it is revoked or expired), the created / last-used /
// expiry metadata, and a revoke action. A revoked token reads as inert; an
// expired one carries a caution badge. An empty list shows a placeholder.
//
// Presentation only: values arrive as props, the revoke leaves as a callback,
// and nothing is fetched. Designed for the minimum width first -- the metadata
// wraps beneath the name on a narrow container.
export function ApiTokenList({ tokens, onRevoke, revokingTokenId, className }: ApiTokenListProps) {
  if (tokens.length === 0) {
    return (
      <div className={cn('flex flex-col items-center gap-2 py-10 text-center', className)}>
        <KeyRound className='size-6 text-muted-foreground' aria-hidden='true' />
        <p className='text-sm font-medium'>No API tokens</p>
        <p className='text-sm text-muted-foreground'>Tokens you create will appear here.</p>
      </div>
    )
  }

  return (
    <ul className={cn('divide-y', className)}>
      {tokens.map((token) => {
        const revoking = revokingTokenId === token.id
        return (
          <li
            key={token.id}
            className='flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4'
          >
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <span className={cn('truncate text-sm font-medium', token.revoked && 'text-muted-foreground line-through')}>
                  {token.name}
                </span>
                {token.revoked ? (
                  <Badge variant='secondary'>Revoked</Badge>
                ) : token.expired ? (
                  <Badge variant='outline' className='border-amber-500/40 text-amber-700'>
                    Expired
                  </Badge>
                ) : null}
              </div>
              <dl className='mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm'>
                <Meta label='Created' value={token.createdAt} />
                <Meta label='Last used' value={token.lastUsedAt ?? 'Never'} />
                {token.expiresAt ? <Meta label='Expires' value={token.expiresAt} /> : null}
              </dl>
            </div>
            <div className='flex shrink-0 justify-end sm:justify-start'>
              {token.revoked ? null : (
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                  onClick={() => onRevoke(token.id)}
                  disabled={revoking}
                >
                  {revoking ? 'Revoking…' : 'Revoke'}
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
