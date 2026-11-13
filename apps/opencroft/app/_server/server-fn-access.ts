// Who may call a server function, decided in one place for all of them.
//
// A `createServerFn` is an HTTP endpoint of its own, reachable without the
// page that leads to it, so the `_authed` route guard does not cover it. The
// session gate (`server-fn-session-gate.ts`) is registered once for every
// server function in `app/start.ts` and asks this module. The answer is
// signed-in unless the function is listed below, so a new server function is
// gated without anyone remembering to gate it, and opening one to anonymous
// callers is an edit to this list that review sees.
//
// No imports: the decision is tested over every server function in the tree
// without a database or a request.

/** What the compiler tells a server middleware about the function it runs for. */
export interface ServerFnIdentity {
  /** The variable the server function is assigned to. */
  name: string
  /** The defining file, relative to the app root (`apps/opencroft`). */
  filename: string
}

/**
 * The server functions an anonymous caller may reach, by file and name.
 * Each one answers a visitor before any account exists or before they sign in.
 */
export const PUBLIC_SERVER_FNS: Readonly<Record<string, readonly string[]>> = {
  // The guard's own question ("is this request signed in?") and the sign-in
  // screen's list of providers.
  'app/(auth)/_server/session.ts': ['getAuthState', 'getSocialProviders'],
  // First-run setup. `createFirstAdmin` refuses once any account exists.
  'app/(auth)/_server/setup.ts': ['getSetupStatus', 'completeSetup'],
  // The palette name the login page is drawn in.
  'app/_server/brand-color-actions.ts': ['getBrandColor'],
}

export function isPublicServerFn(fn: ServerFnIdentity | undefined): boolean {
  if (!fn) {
    return false
  }
  // Own keys only, so a filename such as `constructor` cannot reach the
  // prototype.
  const names = Object.hasOwn(PUBLIC_SERVER_FNS, fn.filename) ? PUBLIC_SERVER_FNS[fn.filename] : undefined
  return names?.includes(fn.name) ?? false
}

/**
 * Admits a call or throws the 401 the framework sends as the response.
 * `signedIn` is asked only for a function that needs a session, so a public
 * function costs no session lookup.
 */
export async function admitServerFnCall(
  fn: ServerFnIdentity | undefined,
  signedIn: () => Promise<boolean>,
): Promise<void> {
  if (isPublicServerFn(fn)) {
    return
  }
  if (!(await signedIn())) {
    throw Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
