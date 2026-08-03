import type { ReactNode } from 'react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { cn } from '@/lib/utils'

export interface AdminUserEditProps {
  // Whose account is open. Always rendered in the header so the admin never
  // loses sight of who they are editing.
  name: string
  email: string
  avatar?: string | null
  // The details form (typically Admin User Form in edit mode). The host wires
  // it to its own state; this shell only places it.
  form?: ReactNode
  // The access controls (typically Admin User Access). Slot so the host keeps
  // full control of disable vs. delete.
  access?: ReactNode
  className?: string
}

// The administrator's user-edit page: a header that always shows whose account
// is open, then the details form and access controls beneath it. It owns no
// data and calls nothing -- it composes the pieces -- but it keeps the
// identity pinned at the top, because someone editing another person's account
// needs to see whose it is at every step, and a long form is exactly where that
// gets lost.
//
// Designed for the minimum width first: the header wraps on a narrow container.
export function AdminUserEdit({ name, email, avatar, form, access, className }: AdminUserEditProps) {
  return (
    <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-8', className)}>
      <header className='flex items-center gap-4'>
        <AgentAvatar avatar={avatar} name={name} size='lg' className='shrink-0' />
        <div className='min-w-0'>
          <h1 className='truncate text-lg font-semibold'>{name}</h1>
          <p className='truncate text-sm text-muted-foreground'>{email}</p>
        </div>
      </header>

      {form ? (
        <section aria-label='Details'>
          <h2 className='mb-4 text-sm font-semibold'>Details</h2>
          {form}
        </section>
      ) : null}

      {access ? (
        <section aria-label='Access'>
          <h2 className='mb-4 text-sm font-semibold'>Access</h2>
          {access}
        </section>
      ) : null}
    </div>
  )
}
