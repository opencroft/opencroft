// The people and agents a signed-in user may pick from when adding a member:
// the shared directories (see `@/app/_server/user-directory` for what it
// exposes and why the shape is three fields), behind this feature's sign-in
// gate. Faces are handed over as addresses, never as the pictures' bytes: a
// picker lists every account and every agent, and the browser should fetch
// each picture once rather than receive all of them inside the list.

import { getSessionUser } from '@opencroft/auth/server'

import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'
import { type DirectoryAgent, listAgentDirectory } from '@/app/_authed/(space)/_server/agents-impl'
import { agentAvatarUrl } from '@/app/_server/agent-avatar'
import { userAvatarUrl } from '@/app/_server/user-avatar'
import { type DirectoryUser, listUserDirectory } from '@/app/_server/user-directory'

export type { DirectoryAgent, DirectoryUser }

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
  await requireSignedIn(request)
  return (await listUserDirectory()).map((u) => ({ ...u, avatarUrl: userAvatarUrl({ id: u.id, image: u.avatarUrl }) }))
}

/** Every agent of every space, as a name and a face. Same gate and same reasoning as `listDirectoryUsers`. */
export async function listDirectoryAgents(request: Request): Promise<DirectoryAgent[]> {
  await requireSignedIn(request)
  return (await listAgentDirectory()).map((a) => ({
    ...a,
    avatarUrl: agentAvatarUrl({ nodeId: a.id, avatar: a.avatarUrl }),
  }))
}

async function requireSignedIn(request: Request): Promise<void> {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) {
    throw new GroupChatAccessError('unauthenticated', 'Sign in to use group chats')
  }
}
