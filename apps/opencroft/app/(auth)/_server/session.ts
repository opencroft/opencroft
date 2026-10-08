// The single question every guarded route asks: is this request allowed in,
// and if not, why not.
//
// EVERY export here must stay a `createServerFn`. This module is reached from
// __root.tsx, so it is in the client graph on every page — it stays out of the
// browser bundle only because the client build replaces each server function
// with an RPC stub, leaving its imports (the auth server, and the database
// connection behind it) unused and droppable. A plain exported function here
// has no stub and would ship all of that to the browser.

import { configuredSocialProviders, countUsers, getSessionUser, type SocialProviderId } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { userAvatarUrl } from '@/app/_server/user-avatar'

// A union rather than one record of optional fields, so a caller that has
// checked `signedIn` holds the account without a second null check.
export type AuthState =
  | {
      /** No accounts exist at all — the instance has never been set up. */
      needsSetup: boolean
      /** This request carries a valid session. */
      signedIn: false
      isAdmin: false
      account: null
    }
  | {
      needsSetup: false
      signedIn: true
      /** The signed-in session belongs to an administrator. */
      isAdmin: boolean
      /** Who is signed in, as the chrome draws them. */
      account: SignedInAccount
    }

export interface SignedInAccount {
  name: string
  email: string
  /** Where to load the avatar from (see `userAvatarUrl`); null when there is none. */
  avatarUrl: string | null
}

/**
 * All of it in one call, deliberately.
 *
 * The guard needs to tell "nobody has set this up yet" apart from "you are not
 * signed in" apart from "you're in, but not an administrator", and asking for
 * them separately would mean multiple round-trips on every navigation to
 * decide one thing. The account rides along because this request has already
 * resolved it: the server-rendered page can then draw who is signed in
 * without the browser asking again once its code has loaded.
 */
export const getAuthState = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<AuthState> => {
    const user = await getSessionUser(getRequest())
    if (user) {
      // Someone is signed in, so accounts plainly exist; skip the count.
      return {
        needsSetup: false,
        signedIn: true,
        isAdmin: user.role === 'admin',
        account: { name: user.name, email: user.email, avatarUrl: userAvatarUrl(user) },
      }
    }
    return { needsSetup: (await countUsers()) === 0, signedIn: false, isAdmin: false, account: null }
  },
)

/**
 * Which social providers this deployment can actually sign someone in with.
 *
 * Asked of the server because the answer is deployment configuration, not
 * something the browser could know — and asked at all so the sign-in screen
 * offers only what can be honoured, and starts offering a provider the moment
 * its credentials exist, with no code change.
 *
 * Typed as the provider union rather than as strings. The values already are
 * that union; annotating them as `string[]` only threw the knowledge away at
 * the boundary, and the screen then could not hand the list to a component that
 * asks for named providers. Keeping it means a provider added on one side and
 * not the other fails to compile, which is where that disagreement should
 * surface.
 */
export const getSocialProviders = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<SocialProviderId[]> => configuredSocialProviders(),
)
