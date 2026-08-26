'use client'

import { UserPlus, Users } from 'lucide-react'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

export interface AdminUser {
  id: string
  name: string
  email: string
  avatar?: string | null
  // Display-ready role label (e.g. "Admin", "Member"). The host owns the
  // vocabulary; nothing in the component reads it for meaning.
  role: string
  // Display-ready strings. The host formats them; this renders verbatim.
  joinedAt: string
  lastSeenAt?: string
  // Still allowed in? When true the row reads as inert and carries a badge.
  disabled?: boolean
}

export interface AdminUsersProps {
  users: AdminUser[]
  // The admin asked to add a user. The create flow (a form) is the host's;
  // this only reports the request.
  onAdd: () => void
  // The admin asked to open a user's edit page.
  onEdit: (userId: string) => void
  className?: string
}

// The administrator's users page, with no page frame around it: a toolbar with
// the add action above a list of rows. Each row answers the question an admin
// actually opens this with -- who is this, and should they still be here -- by
// carrying the identity, role, joined and last-seen dates, and the disabled
// state, not just a name. Whose account it is stays visible in every row.
//
// Presentation only: values arrive as props, add and edit leave as callbacks,
// and nothing is fetched. Designed for the minimum width first -- the row is a
// single line on a wide container and stacks on a narrow one.
export function AdminUsers({ users, onAdd, onEdit, className }: AdminUsersProps) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className='flex items-center justify-between gap-4'>
        <p className='text-sm text-muted-foreground'>
          {users.length} {users.length === 1 ? 'user' : 'users'}
        </p>
        <Button type='button' onClick={onAdd}>
          <UserPlus className='size-4' /> Add user
        </Button>
      </div>

      {users.length === 0 ? (
        <div className='flex flex-col items-center gap-2 py-10 text-center'>
          <Users className='size-6 text-muted-foreground' aria-hidden='true' />
          <p className='text-sm font-medium'>No users yet</p>
          <p className='text-sm text-muted-foreground'>Add someone to get started.</p>
        </div>
      ) : (
        <ul className='divide-y'>
          {users.map((user) => (
            <li
              key={user.id}
              className='flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4'
            >
              <div className='flex min-w-0 flex-1 items-center gap-3'>
                <AgentAvatar avatar={user.avatar} name={user.name} size='md' className='shrink-0' />
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className={cn('truncate text-sm font-medium', user.disabled && 'text-muted-foreground')}>
                      {user.name}
                    </span>
                    <Badge variant='outline'>{user.role}</Badge>
                    {user.disabled ? <Badge variant='secondary'>Disabled</Badge> : null}
                  </div>
                  <p className='truncate text-sm text-muted-foreground'>{user.email}</p>
                </div>
              </div>

              <dl className='flex flex-col gap-0.5 text-sm text-muted-foreground sm:w-52 sm:shrink-0'>
                <div className='flex gap-1.5'>
                  <dt className='shrink-0'>Joined</dt>
                  <dd className='text-foreground'>{user.joinedAt}</dd>
                </div>
                <div className='flex gap-1.5'>
                  <dt className='shrink-0'>Last seen</dt>
                  <dd>{user.lastSeenAt ?? 'never'}</dd>
                </div>
              </dl>

              <div className='flex shrink-0 justify-end'>
                <Button type='button' variant='outline' size='sm' onClick={() => onEdit(user.id)}>
                  Edit
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
