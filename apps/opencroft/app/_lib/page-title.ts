/** The product name, and the tail of every page title. */
export const PRODUCT_NAME = 'OpenCroft'

/**
 * A page's document title, most specific part first and the product name last:
 * `Git · opencroft · OpenCroft`.
 *
 * Blank parts are dropped rather than rendered as an empty gap, which is what
 * makes this safe to call from a route's `head`. That runs before the loader
 * has resolved as well as after — `loaderData` is optional there — so a title
 * naming the thing being opened has to survive not knowing its name yet. With
 * every part dropped the result is the bare product name, the same title the
 * root route sets, so the pending state reads as the app rather than as a gap
 * or a stray separator.
 *
 * The separator is spaced so it cannot be mistaken for part of a name, and is
 * a character slugs do not admit.
 */
export function pageTitle(...parts: Array<string | null | undefined>): string {
  const named = parts.map((part) => part?.trim()).filter((part): part is string => !!part)
  return [...named, PRODUCT_NAME].join(' · ')
}
