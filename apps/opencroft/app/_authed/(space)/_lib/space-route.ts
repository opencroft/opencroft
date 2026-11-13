import { redirect } from '@tanstack/react-router'

import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

/**
 * What a route answers for an address whose space or app does not exist: the
 * root, in place of the dead entry. There is no not-found page for these.
 *
 * `replace` holds on every way in. On the client the router turns a loader's
 * redirect into a navigation that replaces the history entry, so Back and
 * Forward never land on the dead address again; on a document load it is an
 * HTTP redirect, which leaves no entry for the dead address at all. It is set
 * here as well so the intent does not rest on the router's default alone.
 */
export function missingAddress() {
  return redirect({ to: '/', replace: true })
}

/**
 * Settle a space route's loader with the SPACE'S EXISTENCE DECIDED FIRST,
 * before any sibling request's rejection can decide it instead.
 *
 * These loaders need two things at once: the space, and data that only exists
 * for a space that does. The data fetch throws `Unknown space: <slug>` for one
 * that does not -- so run concurrently under `Promise.all`, that rejection would
 * win the race against the loader's own check and reach the crash page with the
 * internal message printed on screen.
 *
 * The verdict is read from THE SPACE LIST THIS LOADER ALREADY HOLDS, never from
 * the shape of the other request's error. That is deliberate: a server
 * function's error crosses the RPC boundary message-only, so an `instanceof`
 * test would hold during SSR and fail silently on client-side navigation, which
 * is the half nobody would have measured.
 *
 * `allSettled` keeps both requests in flight, so a space that exists pays one
 * round of concurrent requests. A genuine failure of the data request still
 * propagates untouched once the space is known to exist -- this turns an
 * unknown space into `missingAddress()`, and nothing else into anything else.
 */
export async function settleSpaceRoute<T>(
  slug: string,
  spaces: Promise<SpaceSummary[]>,
  data: Promise<T>,
): Promise<{ space: SpaceSummary; spaces: SpaceSummary[]; data: T }> {
  const [spacesResult, dataResult] = await Promise.allSettled([spaces, data])
  if (spacesResult.status === 'rejected') {
    throw spacesResult.reason
  }
  const all = spacesResult.value
  const space = all.find((entry) => entry.slug === slug)
  if (!space) {
    throw missingAddress()
  }
  if (dataResult.status === 'rejected') {
    throw dataResult.reason
  }
  return { space, spaces: all, data: dataResult.value }
}
