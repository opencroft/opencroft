// Copy for a failed mutation.
//
// A refusal gets the shared refusal wording (`not-found` and its siblings map
// through the same table the read surfaces use, so a member who lost access
// mid-action reads the same sentence everywhere). Anything else gets the
// caller's own fallback rather than being reported as an access problem —
// the same rule the loaders follow, for the same reason: a network failure
// dressed up as a permission decision sends people to the wrong explanation.

import { groupChatAccessMessage } from '@/app/_authed/(group-chats)/_lib/group-chat-error'

export function failureMessage(error: unknown, fallback: string): string {
  return groupChatAccessMessage(error) ?? fallback
}
