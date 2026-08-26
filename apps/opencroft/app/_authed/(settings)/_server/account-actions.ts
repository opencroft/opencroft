// Self-service account server functions: the signed-in person acting on
// their own name, email, password and avatar. Admin-on-others actions live
// in admin-users-actions.ts — a different design problem (see its header).
//
// EVERY export here must stay a `createServerFn`, for the same reason as
// (auth)/_server/session.ts: this module pulls in the auth server and the
// database connection, and only stays out of the browser bundle because the
// client build replaces each server function with an RPC stub.

import {
  changeOwnEmail,
  changeOwnPassword,
  getOwnAccount,
  updateOwnAvatar,
  updateOwnProfile,
} from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { changeUsername as changeUsernameFor, currentUsername } from '@/app/_server/usernames'
import { usernameRefusalMessage } from '@/app/_shared/username'

export interface OwnAccount {
  id: string
  name: string
  email: string
  image: string | null
  /**
   * The handle that identifies this account, as opposed to the `name` that
   * says what to call them. Null only for an account the backfill has not
   * reached yet — it renders as unset rather than as a blank handle.
   */
  username: string | null
}

export const getAccount = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<OwnAccount | null> => {
    const request = getRequest()
    const account = await getOwnAccount(request)
    if (!account) {
      return null
    }
    return { ...account, username: await currentUsername({ kind: 'user', id: account.id }) }
  },
)

/**
 * Take a different handle, retiring the current one.
 *
 * Returns its refusal rather than throwing it: a thrown server-function error
 * reaches the browser as a message and nothing else, so the caller could not
 * tell "that name is taken" from "that name is not allowed" — and those need
 * different words in front of the person typing.
 */
export const changeUsername = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((next: string) => next)
  .handler(async ({ data: next }): Promise<{ ok: true } | { ok: false; message: string }> => {
    const account = await getOwnAccount(getRequest())
    if (!account) {
      return { ok: false, message: 'Sign in to change your username.' }
    }
    const result = await changeUsernameFor({ kind: 'user', id: account.id }, next)
    if (result.ok) {
      return { ok: true }
    }
    return {
      ok: false,
      message: result.refusal === 'taken' ? 'That username is already taken.' : usernameRefusalMessage(result.refusal),
    }
  })

export const updateProfile = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }): Promise<void> => {
    await updateOwnProfile(getRequest(), name)
  })

export const changeEmail = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((newEmail: string) => newEmail)
  .handler(async ({ data: newEmail }): Promise<void> => {
    await changeOwnEmail(getRequest(), newEmail)
  })

/** Set the avatar, or clear it with `null`. Stored on `user.image`. */
export const updateAvatar = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((image: string | null) => image)
  .handler(async ({ data: image }): Promise<void> => {
    await updateOwnAvatar(getRequest(), image)
  })

export const changePassword = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { currentPassword: string; newPassword: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await changeOwnPassword(getRequest(), data)
  })
