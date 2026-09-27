// The identifiers the core markdown resolvers recognise. Kept apart from the
// resolvers so they can be exercised without the host.

/**
 * A terminal target, "<address>/<handle>", where the address is a node id
 * (`<kind>_<id>`, e.g. `localhost_ab12`) or an App address
 * (`<space>.<app-slug>`), and the handle is a terminal one: `terminal`, a
 * `*-terminal` / `terminal-*` / `worktree-terminal-*` output, or a router's
 * `route-*`. Never the middle of a path or an address: nothing word-like, `/`,
 * `.` or `-` may come right before it, nor a further path segment after it.
 */
export const TERMINAL_TARGET_PATTERN =
  /(?<![\w./-])(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*_[a-z0-9]+|[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*)\/(?:(?:[a-z0-9]+-)*terminal(?:-[A-Za-z0-9-]*[A-Za-z0-9])?|route-[A-Za-z0-9-]*[A-Za-z0-9])(?![\w/-]|\.\w)/

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Any address on this origin; tested against a bare link's whole address. */
export function sameOriginLinkPattern(origin: string): string {
  return `${escapeRegExp(origin)}(?:[/?#].*)?`
}
