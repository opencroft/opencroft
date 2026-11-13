import { Plus } from 'lucide-react'

import { Button } from '../button'
import { FieldDescription, FieldError } from 'ui/components/ui/field'
import { Flex } from '../layout/flex'
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from 'ui/components/ui/item'

export interface AutomatedSenderGrantsProps {
  /** The identifiers this chat grants, each a row with Revoke. */
  granted: string[]
  /** The identifiers that could be granted and are not, each offered as Grant. */
  grantable: string[]
  onGrant: (systemId: string) => void
  onRevoke: (systemId: string) => void
  /** A grant or a revoke is under way: every control waits for it. */
  pending?: boolean
  /** The two lists are still being read. */
  loading?: boolean
  /** The lists could not be read. Shown in their place, because a list that
   *  failed to load and a chat with no grants would otherwise look the same. */
  loadError?: string
  /** A rejected grant or revoke. Displayed, not decided. */
  error?: string
}

// Which automated senders -- a schedule's script, the forge webhook, an
// extension acting on its own -- may deliver into this chat's threads. A short
// closed list of reserved identifiers rather than people to search for, so the
// granted ones are rows and the rest are offered as buttons: nothing is typed,
// and what can be granted is exactly what can send.
//
// The identifiers are code, drawn monospace and truncated in their row with
// the whole of it in the title.
export function AutomatedSenderGrants({
  granted,
  grantable,
  onGrant,
  onRevoke,
  pending,
  loading,
  loadError,
  error,
}: AutomatedSenderGrantsProps) {
  return (
    <Flex withGaps>
      <FieldDescription>A grant lets a scheduled pipeline or a webhook deliver into this chat's threads.</FieldDescription>
      {loading ? (
        <p className='text-sm text-muted-foreground'>Loading automated senders…</p>
      ) : loadError ? (
        <FieldError>{loadError}</FieldError>
      ) : (
        <>
          {granted.length === 0 ? (
            <p className='text-sm text-muted-foreground'>No automated senders are granted to this chat.</p>
          ) : (
            <ItemGroup>
              {granted.map((systemId) => (
                <Item key={systemId} size='xs' variant='outline'>
                  <ItemContent className='min-w-0'>
                    {/* Full width, not the title's own fit-content: a box as wide
                        as the id never truncates it, and runs under Revoke. */}
                    <ItemTitle className='block w-full truncate font-mono text-xs' title={systemId}>
                      {systemId}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      aria-label={`Revoke ${systemId}`}
                      disabled={pending}
                      onClick={() => onRevoke(systemId)}
                    >
                      Revoke
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
          {grantable.length > 0 ? (
            <Flex row withGaps className='flex-wrap'>
              {grantable.map((systemId) => (
                <Button
                  key={systemId}
                  type='button'
                  variant='outline'
                  size='sm'
                  aria-label={`Grant ${systemId}`}
                  disabled={pending}
                  onClick={() => onGrant(systemId)}
                >
                  <Plus />
                  <span className='font-mono text-xs'>{systemId}</span>
                </Button>
              ))}
            </Flex>
          ) : null}
        </>
      )}
      {error ? <FieldError>{error}</FieldError> : null}
    </Flex>
  )
}
