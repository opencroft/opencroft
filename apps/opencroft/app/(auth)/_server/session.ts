// The single question every guarded route asks: is this request allowed in,
// and if not, why not.
//
// EVERY export here must stay a `createServerFn`. This module is reached from
// __root.tsx, so it is in the client graph on every page — it stays out of the
// browser bundle only because the client build replaces each server function
// with an RPC stub, leaving its imports (the auth server, and the database
// connection behind it) unused and droppable. A plain exported function here
// has no stub and would ship all of that to the browser.

import { configuredSocialProviders, countUsers, getSessionUser } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export interface AuthState {
  /** No accounts exist at all — the instance has never been set up. */
  needsSetup: boolean
  /** This request carries a valid session. */
  signedIn: boolean
}

/**
 * Both facts in one call, deliberately.
 *
 * The guard needs to tell "nobody has set this up yet" apart from "you are not
 * signed in", and asking for them separately would mean two round-trips on
 * every navigation to decide one thing.
 */
export const getAuthState = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<AuthState> => {
    const user = await getSessionUser(getRequest())
    if (user) {
      // Someone is signed in, so accounts plainly exist; skip the count.
      return { needsSetup: false, signedIn: true }
    }
    return { needsSetup: (await countUsers()) === 0, signedIn: false }
  },
)

/**
 * Which social providers this deployment can actually sign someone in with.
 *
 * Asked of the server because the answer is deployment configuration, not
 * something the browser could know — and asked at all so the sign-in screen
 * offers only what can be honoured, and starts offering a provider the moment
 * its credentials exist, with no code change.
 */
export const getSocialProviders = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<string[]> => configuredSocialProviders(),
)
