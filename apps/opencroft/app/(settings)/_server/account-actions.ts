// Self-service account server functions: the signed-in person acting on
// their own name, email and password. Admin-on-others actions live in
// admin-users-actions.ts — a different design problem (see its header).
//
// EVERY export here must stay a `createServerFn`, for the same reason as
// (auth)/_server/session.ts: this module pulls in the auth server and the
// database connection, and only stays out of the browser bundle because the
// client build replaces each server function with an RPC stub.

import { changeOwnEmail, changeOwnPassword, getOwnAccount, updateOwnProfile } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export interface OwnAccount {
  id: string
  name: string
  email: string
  image: string | null
}

export const getAccount = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<OwnAccount | null> => getOwnAccount(getRequest()),
)

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

export const changePassword = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { currentPassword: string; newPassword: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await changeOwnPassword(getRequest(), data)
  })
