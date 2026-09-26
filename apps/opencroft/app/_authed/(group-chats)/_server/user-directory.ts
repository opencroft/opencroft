// The people a signed-in user may pick from when adding a member: the shared
// directory (see `@/app/_server/user-directory` for what it exposes and why the
// shape is three fields), behind this feature's sign-in gate.

import { getSessionUser } from '@opencroft/auth/server'

import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'
import { type DirectoryUser, listUserDirectory } from '@/app/_server/user-directory'

export type { DirectoryUser }

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
  return listUserDirectory()
}
