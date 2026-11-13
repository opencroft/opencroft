// The path a Get node reads in an object: dot-separated segments, where a
// segment of digits indexes an array (`user.name`, `items.0.id`). The empty
// path is the object itself. Only own properties are read, and the segments
// that reach an object's prototype are refused, so a path never reads past
// the JSON it was given. A key that holds a dot cannot be reached.
//
// Host-free, so the canvas and the server read a path the same way.

/** Segments that would reach a prototype rather than a property of the JSON. */
const REFUSED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

const INDEX = /^\d+$/

export type ParsePathResult = { ok: true; segments: string[] } | { ok: false; error: string }

/** The segments of `path`, or why it does not parse: an empty segment (`user..name`), or a refused one. */
export function parsePath(path: string): ParsePathResult {
  if (path === '') {
    return { ok: true, segments: [] }
  }
  const segments = path.split('.')
  for (const [i, segment] of segments.entries()) {
    if (segment === '') {
      return { ok: false, error: `The path "${path}" has an empty segment at ${i + 1}` }
    }
    if (REFUSED_SEGMENTS.has(segment)) {
      return { ok: false, error: `The path "${path}" reads "${segment}", which is not a property a path can read` }
    }
  }
  return { ok: true, segments }
}

export type ReadPathResult = { found: true; value: unknown } | { found: false }

/**
 * What `segments` reach in `value`: each segment an own property of an
 * object, or, when it is all digits, an index into an array. Anything else on
 * the way (a missing key, an index past the end, a text or a number) is not
 * found.
 */
export function readPath(value: unknown, segments: readonly string[]): ReadPathResult {
  let current = value
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!INDEX.test(segment) || Number(segment) >= current.length) {
        return { found: false }
      }
      current = current[Number(segment)]
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return { found: false }
    }
  }
  return { found: true, value: current }
}
