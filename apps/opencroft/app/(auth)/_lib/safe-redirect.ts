/**
 * Reduce a `redirect` search param to a path on this origin, or nothing.
 *
 * The guard sends people here with where they were headed, and two different
 * consumers spend that value: a client-side `router.navigate`, and Better
 * Auth's `callbackURL`, which becomes a real server-side redirect. So a value
 * that escapes this function is an open redirect through at least one of them.
 *
 * RESOLVE AN ORIGIN, DO NOT MATCH PREFIXES. The obvious check — starts with
 * `/`, does not start with `//` — is wrong, and wrong in the direction that
 * looks safe. For special schemes the URL parser normalises `\` to `/`, so
 * `/\evil.com` is `//evil.com` by the time anything resolves it, while the
 * string still begins with a single slash:
 *
 *     //evil.com     ->  https://evil.com/            rejected by a prefix check
 *     /\evil.com     ->  https://evil.com/            ACCEPTED by a prefix check
 *     /normal/path   ->  https://<host>/normal/path
 *
 * Resolving against a base and comparing origins rejects absolute URLs,
 * protocol-relative ones and the backslash form by construction, so it does not
 * depend on anyone having enumerated the forms.
 *
 * The base is a reserved `.invalid` name (RFC 2606) that can never be a real
 * origin, so a value resolving to it can only have done so by being relative.
 */
const BASE = 'https://redirect.invalid'

export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value, BASE)
  } catch {
    // Not parseable even as a relative reference — nothing worth carrying.
    return undefined
  }
  if (url.origin !== BASE) {
    return undefined
  }
  // Rebuilt from the parsed parts rather than returned as given, so what the
  // consumers spend is the normalised path rather than the original string.
  return `${url.pathname}${url.search}${url.hash}`
}
