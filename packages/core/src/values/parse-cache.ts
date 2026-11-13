// The parsed forms of the texts a graph's nodes carry (expressions, templates
// and patterns), kept by
// their text so each distinct text is parsed once and every later read of a
// node's handles, outputs and checks reuses it. One process-wide cache of the
// most recently used entries: the canvas and the server each hold their own.

/** How many parsed texts are kept; the least recently used goes first. */
export const PARSE_CACHE_SIZE = 256

const entries = new Map<string, unknown>()

/**
 * What `parse` makes of the text keyed by `key`: computed on the first read of
 * the key and kept, reused on every later read while it is among the
 * `PARSE_CACHE_SIZE` most recently used. `key` names the parser as well as
 * the text (`pattern:i:a+`), so two parsers never share an entry.
 */
export function cachedParse<T>(key: string, parse: () => T): T {
  if (entries.has(key)) {
    const hit = entries.get(key) as T
    entries.delete(key)
    entries.set(key, hit)
    return hit
  }
  const parsed = parse()
  entries.set(key, parsed)
  if (entries.size > PARSE_CACHE_SIZE) {
    entries.delete(entries.keys().next().value as string)
  }
  return parsed
}
