import { notFound } from '@tanstack/react-router'

import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

/**
 * Settle a space route's loader with the SPACE'S EXISTENCE DECIDED FIRST,
 * before any sibling request's rejection can decide it instead.
 *
 * These loaders need two things at once: the space, and data that only exists
 * for a space that does. The data fetch throws `Unknown space: <slug>` for one
 * that does not -- so run concurrently under `Promise.all`, that rejection wins
 * the race against the loader's own `notFound()` and the loader never reaches
 * its own check. That is how an unknown space reached the crash page with the
 * internal message printed on screen, while the canvas route -- which asks for
 * nothing besides the space list -- correctly answered 404.
 *
 * The verdict is read from THE SPACE LIST THIS LOADER ALREADY HOLDS, never from
 * the shape of the other request's error. That is deliberate: a server
 * function's error crosses the RPC boundary message-only, so an `instanceof`
 * test would hold during SSR and fail silently on client-side navigation, which
 * is the half nobody would have measured.
 *
 * `allSettled` keeps both requests in flight, so a space that exists pays
 * exactly what the `Promise.all` it replaces paid. A genuine failure of the
 * data request still propagates untouched once the space is known to exist --
 * this turns an unknown space into a 404, and nothing else into anything else.
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
    throw notFound()
  }
  if (dataResult.status === 'rejected') {
    throw dataResult.reason
  }
  return { space, spaces: all, data: dataResult.value }
}
