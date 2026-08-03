// A signed-in person's OWN API tokens: create, list, revoke. Self-service
// only — this never touches an agent token (subjectType 'agent'), and never
// another person's (every query is scoped to the caller's own userId).
//
// EVERY EXPORT IN THIS FILE MUST STAY A createServerFn. token-settings.tsx
// imports this module, and it is a 'use client' component reached on every
// page load of the settings screen — so this file is in the client graph. The
// client build replaces each createServerFn export with an RPC stub, dropping
// its imports; a plain exported function would have no stub and would ship
// @opencroft/db and the auth server straight to the browser. The actual
// mutation logic lives in token-actions-impl.ts, which this file never
// re-exports as a plain function, only calls from inside a handler.
//
// The page that calls these already sits behind the root session gate, but
// that guards NAVIGATION, not this RPC endpoint directly — a request could
// reach these handlers without ever rendering the page. So each one re-checks
// the session itself rather than trusting the page to have done it.

import { getSessionUser } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import {
  type CreatedToken,
  type CreateTokenInput,
  createTokenForUser,
  listTokensForUser,
  type MyToken,
  revokeTokenForUser,
} from '@/app/_authed/(settings)/_server/token-actions-impl'

export type { CreatedToken, CreateTokenInput, MyToken }

async function requireUserId(): Promise<string> {
  const user = await getSessionUser(getRequest())
  if (!user) {
    // The page cannot reach this state — root beforeLoad redirects first —
    // so this only fires against a direct request. A plain throw is enough:
    // there is no form on screen to show a nicer message to.
    throw new Error('Not signed in')
  }
  return user.id
}

export const listMyTokens = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MyToken[]> => listTokensForUser(await requireUserId()),
)

export const createMyToken = createServerFn({ method: 'POST' })
  .inputValidator((input: CreateTokenInput) => input)
  .handler(async ({ data }): Promise<CreatedToken> => createTokenForUser(await requireUserId(), data))

export const revokeMyToken = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ revokedAt: string }> => revokeTokenForUser(await requireUserId(), data.id))
