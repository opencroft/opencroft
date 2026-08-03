'use client'

// One error surface for every group-chat route.
//
// It reads the refusal through `groupChatAccessMessage`, which branches on
// `error.name` and `.code` — never `instanceof`, which does not survive the
// RPC boundary. Anything that is NOT an access refusal (a network failure, a
// bug) falls back to a generic message rather than being reported as a
// permission problem it has no evidence of.
//
// Nothing here says or implies that agents cannot see a group chat. The
// user-side rule is enforced server-side and needs no announcement, and the
// agent-side lookup is taken on trust — copy claiming otherwise would be
// claiming a guarantee the system does not make.

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'

import { groupChatAccessMessage } from '@/app/_authed/(group-chats)/_lib/group-chat-error'

const GENERIC = 'Something went wrong loading this. Try again.'

export function GroupChatErrorState({ error }: { error: unknown }) {
  // `groupChatAccessMessage` returns null for anything it cannot identify,
  // which is the signal to use our own copy instead of guessing.
  const message = groupChatAccessMessage(error) ?? GENERIC
  return (
    <Empty className='py-12'>
      <EmptyHeader>
        <EmptyTitle>Not available</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
