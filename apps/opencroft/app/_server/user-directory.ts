// The people directory: every account as a name and a face.
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
// intended design — picking a colleague by name is the baseline
// interaction in collaboration software, and names are already visible to
// co-members throughout the product. Emails, roles and sign-in state are not,
// and must not be added here.
//
// Two consumers read it, each behind its own gate: the group-chat member
// picker (a signed-in request), and extensions through `host.users` (an App
// action an agent or a person invoked — the extension server runs trusted, the
// same standing it has for the graph and the database). Neither widens the
// shape; both get exactly these three fields.

import { db, user } from '@opencroft/db'
import { asc } from 'drizzle-orm'

/**
 * One person. Three fields, and the shape is the point — see the note above
 * before adding a fourth.
 */
export interface DirectoryUser {
  id: string
  name: string
  avatarUrl: string | null
}

/** Every account, ordered by name. Ungated: each caller applies its own gate first. */
export async function listUserDirectory(): Promise<DirectoryUser[]> {
  const rows = await db.select({ id: user.id, name: user.name, image: user.image }).from(user).orderBy(asc(user.name))
  return rows.map(directoryUserOf)
}

/**
 * One account in the directory's shape. Also how a signed-in session is handed
 * to an extension: an App action's `callerPerson` and a session route's
 * `person` both come from here, so the two always name a person the same way.
 */
export function directoryUserOf(account: { id: string; name: string; image?: string | null }): DirectoryUser {
  return { id: account.id, name: account.name, avatarUrl: account.image ?? null }
}
