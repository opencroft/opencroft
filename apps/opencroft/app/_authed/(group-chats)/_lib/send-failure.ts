// Turning a refused thread send into something the composer can say.
//
// The refusal arrives as DATA -- `{ ok: false, code }` -- not as a thrown
// error, because a thrown error does not survive the server-function boundary
// intact: it is serialised to `$TSR/Error` with `message` and nothing else, so
// `name` and `code` are gone before any client code can read them. The earlier
// version of this file branched on those fields and therefore never matched a
// real refusal; every one fell through to generic wording.
//
// So the code crosses as a value and the wording is decided here. Matching on
// the message text instead would work until the first copy edit.

import { SendRefusedError } from '@/app/_authed/(agent)/_shared/send-refused-error'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import type { SendThreadMessageResult } from '@/app/_authed/(group-chats)/_server/actions'

/**
 * The error a refused send should throw, or null when it was delivered.
 *
 * The copy comes from the same table the read surfaces use, so someone who
 * loses access mid-send reads the same sentence everywhere.
 */
export function threadSendRefusal(result: SendThreadMessageResult): SendRefusedError | null {
  return result.ok ? null : new SendRefusedError(groupChatAccessMessageForCode(result.code))
}
