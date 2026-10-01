'use client'

import { Button } from 'ui/components/ui/button'
import { Switch } from 'ui/components/ui/switch'
import { cn } from 'cn'

export interface AdminUserAccessProps {
  // Whose account this is. Runs through every label so the admin can never act
  // on the wrong person, however far down they have scrolled.
  userName: string
  // Current sign-in access. true = the user cannot sign in (disabled); their
  // account and data are kept. false = they can sign in.
  disabled: boolean
  // Flips sign-in access. Reversible: toggling back re-enables the account.
  onToggleDisabled: () => void
  // The admin asked to delete the account. Irreversible -- and deliberately
  // a separate act from disabling, in its own section, with confirmation left
  // to the host.
  onDelete: () => void
  // A delete is in flight: the button goes inert and says so.
  deleting?: boolean
  // A disable/enable is in flight: the switch goes inert.
  toggling?: boolean
  className?: string
}

// The access controls for another person's account -- where the irreversible
// acts live. Disabling and deleting are different things with different
// consequences, so they are never one control:
//
//   - Sign-in access is a reversible toggle. Turning it off keeps the account
//     and its data; the person just cannot get in. It is framed plainly.
//   - Delete is a separate, contained, destructive section of its own, with a
//     red border and a destructive button, so it cannot be reached by accident
//     and never reads as the same gesture as disabling.
//
// The person's name runs through both, because someone editing another
// person's account needs to see whose account it is at every step.
//
// Presentation only: values arrive as props, the toggle and delete leave as
// callbacks, and confirmation is the host's -- this only reports the click.
export function AdminUserAccess({
  userName,
  disabled,
  onToggleDisabled,
  onDelete,
  deleting,
  toggling,
  className,
}: AdminUserAccessProps) {
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/* Sign-in access -- reversible. */}
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0'>
          <h2 className='text-sm font-semibold'>Sign-in access</h2>
          <p className='mt-1 text-sm text-muted-foreground'>
            {disabled
              ? `${userName} cannot sign in. Their account and data are kept — turn this back on to restore access.`
              : `${userName} can sign in. Turn this off to keep the account without letting them in.`}
          </p>
        </div>
        <Switch
          checked={!disabled}
          onCheckedChange={onToggleDisabled}
          disabled={toggling}
          aria-label={disabled ? `Allow ${userName} to sign in` : `Stop ${userName} from signing in`}
          className='mt-0.5 shrink-0'
        />
      </div>

      {/* Delete -- irreversible, in a section of its own so it is never the
          same gesture as disabling and cannot be reached by accident. */}
      <div className='rounded-lg border border-destructive/30 p-4'>
        <h2 className='text-sm font-semibold text-destructive'>Delete account</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          Permanently delete {userName}&rsquo;s account and remove their data. This cannot be undone.
        </p>
        <Button
          type='button'
          variant='destructive'
          onClick={onDelete}
          disabled={deleting}
          className='mt-3'
        >
          {deleting ? 'Deleting…' : 'Delete account'}
        </Button>
      </div>
    </div>
  )
}
