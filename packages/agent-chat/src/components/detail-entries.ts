import type { DetailEntry, DetailItem } from './chat-turn'

/**
 * The entries a turn's reply chain renders: its items, plus -- only sometimes
 * -- a header in front of them.
 *
 * The header is an entry with no content of its own; what it carries is the
 * assistant's name and the time the reply began, which belong to the turn
 * rather than to any one thing in it. It is prepended only when the first item
 * is NOT assistant text, because the first entry is the one that renders those,
 * and where a reply opens with words that item's own entry carries them
 * already. A header above it would say the same thing twice.
 *
 * An empty turn gets no header: there is no first entry for the name to sit on
 * and nothing yet to attribute.
 */
export function withHeader(items: DetailItem[]): DetailEntry[] {
  const entries: DetailEntry[] = items.map((item) => ({ kind: 'item', item }))
  if (items[0] && items[0].kind !== 'assistant-text') {
    entries.unshift({ kind: 'header' })
  }
  return entries
}

/**
 * One key per entry, in the order `entries` are rendered -- and deliberately
 * not the entry's own position in that list.
 *
 * WHY NOT THE POSITION IN `entries`. The header above is prepended
 * conditionally, so an entry's index there is its index in `items` plus a
 * header or not, and that offset FLIPS the moment the first item's kind
 * changes. Every entry after it renumbers at once, and React remounts each one:
 * the rail segments are keyed here while the tool nodes inside them are keyed
 * by their own id, so a shift throws away the wrappers and takes their children
 * with them.
 *
 * Keying by an item's position in `items` removes that at the source, because
 * those indices do not move when the header appears or disappears. That is the
 * whole of the fix, and what makes it worth stating is what it does NOT need: a
 * promise from the host that `items` stays append-only with a stable first
 * kind. The component does not own that property and cannot check it.
 *
 * A tool call has a real identity and uses it. The two spaces are namespaced
 * because they would otherwise overlap -- a tool whose id is "3" and the item
 * at position 3 are different entries and must never be one key.
 *
 * WHAT THIS DOES NOT DO, because it will otherwise be read as covering it: it
 * does not make keys stable against `items` itself being reordered, or having
 * an entry inserted into or removed from its middle. Position remains the
 * identity for text and thinking entries, which is what the declaration of
 * `DetailItem` says and why giving them an id would be inventing data the host
 * does not have. What would retire the positional half is those entries
 * arriving with an identity of their own.
 *
 * The offset is read as the difference in length rather than by re-testing the
 * header's condition, so this and `withHeader` cannot come to disagree about
 * whether a header is present.
 */
export function detailEntryKeys(entries: DetailEntry[], items: DetailItem[]): string[] {
  const headerOffset = entries.length - items.length
  return entries.map((entry, index) => {
    if (entry.kind === 'header') {
      return 'header'
    }
    if (entry.item.kind === 'tool') {
      return `tool:${entry.item.id}`
    }
    return `pos:${index - headerOffset}`
  })
}
