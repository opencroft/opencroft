// Server functions behind the first-run setup screen.
//
// EVERY export here must stay a `createServerFn`. This module is imported by
// the /setup route, which is client-rendered, so it sits in the client graph —
// it stays out of the browser bundle only because the client build replaces
// each server function with an RPC stub, leaving its imports (the auth server,
// and the database connection behind it) unused and droppable. A single plain
// exported function has no stub and would ship all of that to the browser.

import { countUsers, createFirstAdmin, SetupError, type SetupFailure } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'

/**
 * Whether the instance still has no accounts. This is the only thing that makes
 * the setup screen reachable, and it is answered server-side so the browser
 * cannot talk itself into showing it.
 */
export const getSetupStatus = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<{ needsSetup: boolean }> => ({ needsSetup: (await countUsers()) === 0 }),
)

/**
 * Create the first administrator.
 *
 * The "has setup already run" check lives in createFirstAdmin, not here — this
 * is a route anyone can reach, so the refusal has to sit at the thing that
 * writes, not at the thing that renders.
 */
export const completeSetup = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { name: string; email: string; password: string }) => data)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: SetupFailure }> => {
    try {
      await createFirstAdmin(data)
      return { ok: true }
    } catch (error) {
      // This endpoint is reachable by anyone before the first account exists,
      // so it answers with one of a fixed set of outcomes and never with the
      // error's own text — which would have described the database and the
      // auth library to a stranger, and one of those messages names an address
      // to delete by hand.
      //
      // The real error goes to the log, where the operator who can act on it
      // is looking.
      console.error('[setup] first-admin creation failed:', error)
      const reason: SetupFailure = error instanceof SetupError ? error.code : 'failed'
      // A rejected setup is an ordinary outcome the screen has a place to
      // show, so it comes back as a value rather than a thrown error.
      return { ok: false, reason }
    }
  })
