import type { MentionCandidate } from 'agent-chat/components/mention-autocomplete'

import type { MemberRef } from '@/app/_authed/(group-chats)/_server/actions'

/**
 * A chat's people and agents as its composer offers them to mention: each by
 * the handle a mention writes, in name order. Every member that still exists
 * has a handle by the time the view is read; one whose node or account is gone
 * has none and is not offered. System senders are not members in this view at
 * all.
 */
export function mentionCandidates(members: readonly MemberRef[]): MentionCandidate[] {
  return members
    .flatMap((member) =>
      member.username ? [{ handle: member.username, name: member.name, avatarUrl: member.avatarUrl }] : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}
