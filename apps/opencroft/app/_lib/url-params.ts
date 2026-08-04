// Search-parameter arithmetic, deliberately free of React and of any router, so
// the one rule that is easy to get wrong can be stated once and tested directly.

function toParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === 'string' ? new URLSearchParams(search) : search
}

/** The value of `name` in `search`, or `null` when it is absent. */
export function readUrlParam(search: string | URLSearchParams, name: string): string | null {
  return toParams(search).get(name)
}

/**
 * The complete set of search parameters that results from setting `name` to
 * `value` — or from removing it, when `value` is `null`. Every other parameter
 * is carried across unchanged.
 *
 * The result is the whole set rather than a patch, and that is the point.
 * Navigation APIs that accept a partial update merge it into what is already
 * there, and under a merge an absent key means "leave this one alone" — so
 * removal cannot be expressed at all, and a parameter asked to go away simply
 * stays. Rebuilding the full set is what makes clearing one possible.
 *
 * A repeated key collapses to its last occurrence: the result is a flat record,
 * which is the shape navigation takes, and nothing here needs to tell
 * `?a=1&a=2` apart from `?a=2`.
 */
export function withUrlParam(
  search: string | URLSearchParams,
  name: string,
  value: string | null,
): Record<string, string> {
  const next: Record<string, string> = {}
  toParams(search).forEach((existing, key) => {
    if (key !== name) {
      next[key] = existing
    }
  })
  if (value !== null) {
    next[name] = value
  }
  return next
}
