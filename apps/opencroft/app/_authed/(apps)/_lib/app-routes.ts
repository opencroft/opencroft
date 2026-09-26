// An App instance lives at `/space/<space>/app/<app>`, and everything after
// that is the App's own path.

const APP_BASE = /^\/space\/[^/]+\/app\/[^/]+/

/** The instance's own address inside `pathname`, or null off an App page. */
export function appBasePath(pathname: string): string | null {
  return pathname.match(APP_BASE)?.[0] ?? null
}

/** The App-relative path of `pathname` under `base`: always starts with `/`. */
export function appPathOf(pathname: string, base: string): string {
  return pathname.slice(base.length) || '/'
}

/**
 * The address an App's `to` names, from the page it is on. `to` is an App
 * path (`/item/K-1?tab=activity`) or, for the page the App is already on,
 * just a query (`?tab=activity`). Anything else is refused rather than
 * guessed at: an App addresses only its own pages, so neither another origin
 * nor a `.` or `..` segment that would climb out of them is accepted.
 */
export function resolveAppHref(base: string, currentPath: string, to: string): string {
  if (to.startsWith('?')) {
    return `${base}${currentPath === '/' ? '' : currentPath}${to === '?' ? '' : to}`
  }
  const segments = to.split('?')[0].split('/')
  if (to.startsWith('/') && !to.startsWith('//') && !segments.some((part) => part === '.' || part === '..')) {
    return to === '/' || to.startsWith('/?') ? `${base}${to.slice(1)}` : `${base}${to}`
  }
  throw new Error(`An App link must be an App path starting with "/" or a query starting with "?"; got "${to}"`)
}
