import { requireGroupChatMember } from '@/app/_authed/(group-chats)/_server/model'
import {
  readThreadLayout,
  type ThreadLayout,
  type VersionedThreadLayout,
  writeThreadLayout,
} from '@/app/_authed/(group-chats)/_server/thread-layout-store'

// ── Membership-gated, and the only pair a server function may call ───────
//
// Same split as artifacts.ts: the check lives with the data rather than in the
// createServerFn wrapper, so a new caller cannot reach the rows by skipping a
// layer. Kept out of the store itself so the store imports nothing from the
// group-chat model -- the model writes layouts too, on an agent's behalf, and
// behind its own gate.

/** The layout of a chat the caller is a member of. */
export async function getThreadLayout(request: Request, groupChatId: string): Promise<VersionedThreadLayout> {
  await requireGroupChatMember(request, groupChatId)
  return readThreadLayout(groupChatId)
}

/**
 * Replace the layout of a chat the caller is a member of.
 *
 * `null` still means the version check refused it, and it means nothing about
 * membership: a non-member gets the same refusal every other group-chat read
 * gets, thrown, rather than a quiet null that a client would report as a lost
 * race.
 */
export async function putThreadLayout(
  request: Request,
  groupChatId: string,
  layout: ThreadLayout,
  expectedVersion: number,
): Promise<number | null> {
  await requireGroupChatMember(request, groupChatId)
  return writeThreadLayout(groupChatId, layout, expectedVersion)
}
