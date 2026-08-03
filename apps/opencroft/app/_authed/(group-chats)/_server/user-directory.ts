// The people a signed-in user may pick from when adding a member.
//
// DELIBERATELY ITS OWN FUNCTION AND ITS OWN SHAPE, not a relaxed
// `listUsersAsAdmin`. That function returns email, role, disabled and
// last-seen, and it refuses a non-admin — all correct for the administrator's
// users screen and all wrong here. Widening it would have made every one of
// those fields readable by every signed-in account as a side effect of a
// picker needing names, and the next widening would have been invisible. A
// separate function with a three-field shape means any future addition to what
// a non-admin can read about other accounts is a change someone has to make on
// purpose, in a diff that shows it.
//
// What this exposes, stated plainly so it is reviewable: any signed-in user
// can enumerate every account's id, display name and avatar. That is the
// intended design — picking a colleague by
// name is the baseline interaction in collaboration software, and names are
// already visible to co-members throughout the product. Emails, roles and
// sign-in state are not, and must not be added here.
//
// Lives under (group-chats) because that is its only consumer today. If a
// second surface needs a people directory, this belongs in a shared home
// rather than being imported across feature folders.

import { getSessionUser } from '@opencroft/auth/server'
import { db, user } from '@opencroft/db'
import { asc } from 'drizzle-orm'

import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'

/**
 * One pickable person. Three fields, and the shape is the point — see the
 * note above before adding a fourth.
 *
 * Structurally compatible with the `MemberRef` the phase 2 components already
 * render, so a candidate and an existing member draw alike.
 */
export interface DirectoryUser {
  id: string
  name: string
  avatarUrl: string | null
}

/**
 * Every account, as a name and a face.
 *
 * Signed-in only. The check is here in the model, not left to a route: a
 * `createServerFn` is a callable endpoint in its own right, which is the
 * discipline every other read in this feature follows.
 *
 * Not filtered to "addable" for a particular group chat. Which candidates are
 * already members is a question the caller can answer from the membership it
 * has already loaded, and doing it here would mean this read needed a group
 * chat — and a membership check — to return a list of names, which is a
 * heavier contract than the picker needs.
 */
export async function listDirectoryUsers(request: Request): Promise<DirectoryUser[]> {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) {
    throw new GroupChatAccessError('unauthenticated', 'Sign in to use group chats')
  }
  const rows = await db.select({ id: user.id, name: user.name, image: user.image }).from(user).orderBy(asc(user.name))
  return rows.map((row) => ({ id: row.id, name: row.name, avatarUrl: row.image ?? null }))
}
