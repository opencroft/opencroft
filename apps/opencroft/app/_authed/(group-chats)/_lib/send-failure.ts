// Turning a failed thread send into something the composer can say.
//
// A group-chat refusal is an answer, not a fault: the caller lost access, or
// the thread's agent was removed and the conversation is readable but not
// writable. Those carry copy the reader can act on, so they become a
// SendRefusedError and the chat hook shows that copy verbatim.
//
// Anything else -- a network failure, a bug -- is passed through untouched and
// reported as a generic send failure. Same rule the loaders follow, for the
// same reason: a network failure dressed up as a permission decision sends
// people to the wrong explanation.

import { SendRefusedError } from '@/app/_authed/(agent)/_shared/send-refused-error'
import { groupChatAccessMessage } from '@/app/_authed/(group-chats)/_lib/group-chat-error'

/** The error a failed thread send should actually throw. */
export function threadSendFailure(error: unknown): unknown {
  const refusal = groupChatAccessMessage(error)
  return refusal ? new SendRefusedError(refusal) : error
}
