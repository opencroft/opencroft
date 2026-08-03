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

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'

import type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import {
  groupChatAccessMessage,
  groupChatAccessMessageForCode,
} from '@/app/_authed/(group-chats)/_lib/group-chat-error'

const GENERIC = 'Something went wrong loading this. Try again.'

function Shell({ message }: { message: string }) {
  return (
    <Empty className='py-12'>
      <EmptyHeader>
        <EmptyTitle>Not available</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** A refusal the loader already identified. */
export function GroupChatRefusal({ code }: { code: GroupChatAccessFailure }) {
  return <Shell message={groupChatAccessMessageForCode(code)} />
}

/** Anything that reached an error boundary — by now, only the unexpected. */
export function GroupChatErrorState({ error }: { error: unknown }) {
  return <Shell message={groupChatAccessMessage(error) ?? GENERIC} />
}
