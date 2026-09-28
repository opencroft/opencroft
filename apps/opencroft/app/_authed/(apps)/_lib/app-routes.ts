// An App instance lives at `/space/<space>/app/<app>`, and everything after
// that is the App's own path.

const APP_BASE = /^\/space\/[^/]+\/app\/[^/]+/

/**
 * The page address of the instance at `<space>.<app>`, the address `app_call`
 * takes. Split at the first dot, as the server resolves one; an address that
 * is not of that form is refused rather than turned into a page that cannot
 * exist.
 */
export function appInstanceBase(address: string): string {
  const dot = address.indexOf('.')
  const space = address.slice(0, dot)
  const app = address.slice(dot + 1)
  if (dot <= 0 || !app || app.includes('.') || /[/?#]/.test(address)) {
    throw new Error(`An App address is "<space>.<app>"; got "${address}"`)
  }
  return `/space/${space}/app/${app}`
}

/** The instance's own address inside `pathname`, or null off an App page. */
export function appBasePath(pathname: string): string | null {
  return pathname.match(APP_BASE)?.[0] ?? null
}

/**
 * The App-relative path of `pathname` under `base`, always starting with `/`;
 * null when `pathname` is not one of the App's addresses — the host is
 * leaving the App (another App, the graph, Back out of it) while the App is
 * still mounted.
 */
export function appPathOf(pathname: string, base: string): string | null {
  if (pathname === base) {
    return '/'
  }
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function matchesPattern(pattern: string, segments: string[]): boolean {
  const parts = pathSegments(pattern)
  const rest = parts.at(-1) === '**'
  const fixed = rest ? parts.slice(0, -1) : parts
  if (rest ? segments.length < fixed.length : segments.length !== fixed.length) {
    return false
  }
  return fixed.every((part, i) => part === '*' || part === segments[i])
}

/**
 * Whether the App page at `appPath` is one of the App's full-page routes
 * (`AppEntry.fullPageRoutes`): `*` is exactly one segment, a final `**` any
 * number of them including none. The query plays no part.
 */
export function isFullPageRoute(patterns: readonly string[] | undefined, appPath: string): boolean {
  const segments = pathSegments(appPath.split('?')[0])
  return (patterns ?? []).some((pattern) => matchesPattern(pattern, segments))
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
