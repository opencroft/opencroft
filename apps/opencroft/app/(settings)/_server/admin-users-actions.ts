// Admin-on-others account management: an administrator listing, creating,
// editing, disabling and deleting OTHER people's accounts. Self-service
// (a person acting on their own account) is account-actions.ts — a
// different design problem, not this one with a different subject.
//
// EVERY export here must stay a `createServerFn` — see account-actions.ts's
// header for why. Admin authorization is NOT this file's job: every function
// below delegates straight to packages/auth/server.ts, which calls
// `requireAdminUser` itself. That is the single source of the check
// for admin access — this file does not re-derive it, and neither should
// anything else that needs it (e.g. API token management).

import {
  type AdminListedUser,
  createUserAsAdmin,
  deleteUserAsAdmin,
  getUserAsAdmin,
  hasSingleAdmin,
  listUsersAsAdmin,
  type Role,
  setUserDisabledAsAdmin,
  updateUserAsAdmin,
} from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export const listUsers = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<AdminListedUser[]> => listUsersAsAdmin(getRequest()),
)

export const getUser = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((userId: string) => userId)
  .handler(async ({ data: userId }): Promise<AdminListedUser | null> => getUserAsAdmin(getRequest(), userId))

/** Whether the instance currently has exactly one administrator. */
export const getSingleAdminWarning = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<boolean> => hasSingleAdmin(),
)

export interface CreateUserInput {
  name: string
  email: string
  password: string
  role: Role
}

export const createUser = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: CreateUserInput) => data)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const user = await createUserAsAdmin(getRequest(), data)
    return { id: user.id }
  })

export interface UpdateUserInput {
  userId: string
  name: string
  email: string
  role: Role
}

export const updateUser = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: UpdateUserInput) => data)
  .handler(async ({ data }): Promise<void> => {
    await updateUserAsAdmin(getRequest(), data.userId, { name: data.name, email: data.email, role: data.role })
  })

export const setUserDisabled = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { userId: string; disabled: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    await setUserDisabledAsAdmin(getRequest(), data.userId, data.disabled)
  })

export const deleteUser = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((userId: string) => userId)
  .handler(async ({ data: userId }): Promise<void> => {
    await deleteUserAsAdmin(getRequest(), userId)
  })
