// The identifiers the core markdown resolvers recognise. Kept apart from the
// resolvers so they can be exercised without the host.

// The node ids graphs hold. Every new node gets a UUID (`newGraphId`, whoever
// creates it). `<type-id>_<suffix>` is legacy: the canvas made it before that
// and nothing makes it now, but nodes created then still carry it.
const NODE_ID_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const NODE_ID_LEGACY = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*_[a-z0-9]+'
// An App instance by its address.
const APP_ADDRESS = '[a-z0-9]+(?:-[a-z0-9]+)*\\.[a-z0-9]+(?:-[a-z0-9]+)*'
const TERMINAL_HANDLE = '(?:[a-z0-9]+-)*terminal(?:-[A-Za-z0-9-]*[A-Za-z0-9])?|route-[A-Za-z0-9-]*[A-Za-z0-9]'

/**
 * A terminal target, "<address>/<handle>", where the address is a node id -- a
 * UUID, or on nodes created before UUIDs the legacy `<kind>_<id>` such as
 * `localhost_ab12` -- or an App address (`<space>.<app-slug>`), and the handle
 * is a terminal one: `terminal`, a `*-terminal` / `terminal-*` /
 * `worktree-terminal-*` output, or a router's `route-*`. Never the middle of a
 * path or an address: nothing word-like, `/`, `.` or `-` may come right before
 * it, nor a further path segment after it.
 */
export const TERMINAL_TARGET_PATTERN = new RegExp(
  `(?<![\\w./-])(?:${NODE_ID_UUID}|${NODE_ID_LEGACY}|${APP_ADDRESS})\\/(?:${TERMINAL_HANDLE})(?![\\w/-]|\\.\\w)`,
)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Any address on this origin; tested against a bare link's whole address. */
export function sameOriginLinkPattern(origin: string): string {
  return `${escapeRegExp(origin)}(?:[/?#].*)?`
}
