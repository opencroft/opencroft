import { useMemo } from 'react'
import type { ChatContextUsage, ChatStatus } from 'ui/chat/chat-list-item'

import { type SessionActivity, useSessionActivity } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import type { GroupChatThreadListEntry } from '@/app/_authed/(group-chats)/_server/read-model'

/** What a thread's row shows about its session, beside the thread's own name and agent. */
export interface ThreadRowState {
  status: ChatStatus
  context?: ChatContextUsage
}

/** Each thread's row state, keyed by thread id. */
export type ThreadRowStateById = ReadonlyMap<string, ThreadRowState>

/**
 * One thread's row state, from the pushed session activity.
 *
 * The context is the session's live reading when it has one. Otherwise it is
 * the newer of two past readings, each carrying `asOf` and so drawn as a
 * reading from then: the last live one this page saw before the session went
 * quiet, and the one the session stored at its last turn end, as of when the
 * list loaded. A session that has just loaded has reported nothing yet, and a
 * stopped one reports nothing at all; both still held what they last had.
 */
export function threadRowState(
  thread: Pick<GroupChatThreadListEntry, 'sessionKey' | 'lastContextUsage'>,
  activity: SessionActivity,
): ThreadRowState {
  const context =
    activity.usage.get(thread.sessionKey) ??
    newerReading(activity.departedUsage.get(thread.sessionKey), thread.lastContextUsage ?? undefined)
  return {
    status: deriveSessionStatus(thread.sessionKey, activity),
    ...(context ? { context } : {}),
  }
}

function newerReading(
  departed: ChatContextUsage | undefined,
  stored: ChatContextUsage | undefined,
): ChatContextUsage | undefined {
  if (!departed || !stored) {
    return departed ?? stored
  }
  return (stored.asOf ?? 0) > (departed.asOf ?? 0) ? stored : departed
}

/**
 * Every listed thread's row state, kept current by the pushed session
 * activity -- the one source every thread list reads, so a row says the same
 * thing about a session wherever it is drawn.
 */
export function useThreadRowStates(threads: readonly GroupChatThreadListEntry[]): ThreadRowStateById {
  const activity = useSessionActivity()
  return useMemo(() => new Map(threads.map((t) => [t.id, threadRowState(t, activity)] as const)), [threads, activity])
}
