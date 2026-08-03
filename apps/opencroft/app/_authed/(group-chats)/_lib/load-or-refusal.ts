// Turning a refusal into loader DATA instead of a thrown error.
//
// Why this exists rather than each route throwing and relying on its
// `errorComponent`: that arrangement was measured in testing and it
// did not hold. Direct navigation to a group chat the caller could not have
// reached the intended refusal screen once in five attempts; the other four
// rendered a generic error at HTTP 500, and a fabricated id produced the
// generic screen five times out of five. The browser console carried React's
// `CatchBoundaryImpl` reporting the loader error as uncaught, plus one
// "recovered by synchronously rendering the entire root".
//
// I have not tried to characterise exactly when that boundary does and does
// not run — every route in this app that expects a loader to fail throws
// `notFound()`, a router-level signal, and these were the only routes relying
// on a raw throw reaching `errorComponent`. Rather than depend on behaviour
// that measurably differs between a server render and a client transition,
// this removes the dependency: a refusal is an expected outcome of these
// loaders, so it is returned like any other value and rendered from loader
// data. Nothing is thrown, so nothing lands in a console, and the same code
// path runs however the page was reached.
//
// Anything that is NOT a recognised refusal is rethrown untouched. A bug or a
// network failure must not be quietly reported to the user as "not available"
// — that would be inventing an access decision the server never made.

import type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { groupChatAccessCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'

export type Loaded<T> = ({ refused: false } & T) | { refused: true; code: GroupChatAccessFailure }

export async function loadOrRefusal<T>(load: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { refused: false, ...(await load()) }
  } catch (error) {
    const code = groupChatAccessCode(error)
    if (code) {
      return { refused: true, code }
    }
    throw error
  }
}
