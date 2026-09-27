'use client'

// The refusal / failure surface for every group-chat route.
//
// TWO ENTRY POINTS, because there are two different situations:
//
// `GroupChatRefusal` takes a CODE a loader already resolved. This is the one
// that matters. Loaders catch a refusal and return the code as data instead of
// rethrowing it, so the refusal is rendered from loader data on every path —
// server render, direct navigation, client transition alike. Testing found the
// previous arrangement (throw, and let the route's errorComponent catch it)
// reaching the intended screen only once in five direct navigations; the other
// four produced a generic error at HTTP 500, and the raw refusal was visible
// in the browser console every time. Returning data does not depend on which
// boundary runs, and throws nothing for a console to log.
//
// `GroupChatErrorState` keeps the error-shaped form for `errorComponent`,
// which now only ever sees the unexpected — a genuine bug or a network
// failure. Those are NOT reported as access problems.
//
// Nothing here implies agent-side privacy, and the refusal copy says nothing
// about existence or membership: the server now sends one code and one message
// for "you cannot have this", and this is the second line of defence, not the
// thing holding that property up.

import type { ReactNode } from 'react'
import { Button } from 'ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'

import type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import {
  groupChatAccessMessage,
  groupChatAccessMessageForCode,
} from '@/app/_authed/(group-chats)/_lib/group-chat-error'

const GENERIC = 'Something went wrong loading this. Try again.'

function Shell({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <Empty className='py-12'>
      <EmptyHeader>
        <EmptyTitle>Not available</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

/**
 * A refusal the loader already identified. `action` is the way out a page
 * offers -- a link to where the reader can go instead; a surface with a Back
 * of its own passes none.
 */
export function GroupChatRefusal({ code, action }: { code: GroupChatAccessFailure; action?: ReactNode }) {
  return <Shell message={groupChatAccessMessageForCode(code)} action={action} />
}

/** Anything that reached an error boundary — by now, only the unexpected. */
export function GroupChatErrorState({ error }: { error: unknown }) {
  return <Shell message={groupChatAccessMessage(error) ?? GENERIC} />
}

// A thread's own two outcomes, beside the refusal above. Both surfaces that
// open a thread by id -- the thread route and the embedded chat -- render
// these, so a reader is told the same thing wherever they were reading. Each
// takes the same optional `action` as the refusal: the thread route passes its
// link back to the thread list, the dock passes none because its header's
// Back already leads there.

/**
 * The chat holds no such thread: it was deleted. Only ever said to a member
 * of that chat -- the lookup behind it checks membership first -- which is
 * what makes it safe to say at all.
 */
export function GroupChatThreadGone({ action, className }: { action?: ReactNode; className?: string }) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyTitle>This thread was deleted</EmptyTitle>
        <EmptyDescription>
          It is no longer in this chat. Go back to the thread list to open another one.
        </EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

/** Loading the thread failed for a reason that is not an answer about it. */
export function GroupChatThreadLoadFailed({
  onRetry,
  action,
  className,
}: {
  onRetry: () => void
  action?: ReactNode
  className?: string
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyTitle>This thread could not be loaded</EmptyTitle>
        <EmptyDescription>Something went wrong loading it.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className='flex flex-wrap justify-center gap-2'>
          <Button size='sm' variant='outline' onClick={onRetry}>
            Try again
          </Button>
          {action}
        </div>
      </EmptyContent>
    </Empty>
  )
}
