// Turning a refused group-chat write into the copy its dialog shows -- member
// add/remove originally, now also rename and topic edit, which refuse through
// the exact same `GroupChatWriteResult` shape.
//
// The refusal arrives as DATA -- `{ ok: false, code }` -- not as a thrown
// error, for the same reason `send-failure.ts` documents: a thrown error does
// not survive the server-function boundary intact, so a client-side branch on
// `name`/`code` never matches and every refusal falls through to the dialog's
// own generic fallback. Manual testing observed exactly that
// for this path: the last-user-member refusal read as "That
// member could not be removed." instead of the mapped sentence.
//
// Unlike the thread send path, these dialogs own their try/catch directly
// rather than routing through a shared hook that only knows how to react to a
// throw -- so there is no need for a SendRefusedError-style reification here.
// The result is read as data and turned straight into copy.

import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import type { GroupChatWriteResult } from '@/app/_authed/(group-chats)/_server/actions'

/**
 * The copy to show for a refused group-chat write, or null when it succeeded.
 */
export function memberActionRefusal(result: GroupChatWriteResult): string | null {
  return result.ok ? null : groupChatAccessMessageForCode(result.code)
}
