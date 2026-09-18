// The rule that was wrong was the DERIVATION, not the rendering: an entry's
// place in `entries` is its place in `items` plus a header or not, and that
// offset flips with the first item's kind.
//
// It is tested here rather than through a render because nothing in this
// package can observe the consequence. React keys have no effect on output,
// only on what React does with a SECOND render, and every render test here goes
// through `renderToStaticMarkup`, which produces identical markup for any key
// whatsoever. A green suite would say "it still renders" and nothing about the
// keys -- so the property is pinned where it is decidable, which is as a
// function of two lists.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { DetailEntry, DetailItem } from './chat-turn'
import { detailEntryKeys, withHeader } from './detail-entries'

const text = (t: string): DetailItem => ({ kind: 'assistant-text', text: t })
const thinking = (t: string): DetailItem => ({ kind: 'thinking', text: t })
const tool = (id: string): DetailItem => ({ kind: 'tool', id, name: 'read_file', args: {} })
const task = (id: string): DetailItem => ({ kind: 'task', id, name: 'watcher', state: 'running' })

// The header the component would render in front of these items, or not.
// Built through the real `withHeader` so the two cannot disagree about when one
// is due.
const entriesFor = (items: DetailItem[]) => withHeader(items)

// The shape of the entry list, which is the whole subject of the first test.
const kinds = (items: DetailItem[]) => entriesFor(items).map((entry) => entry.kind)

test('a header is due only when the reply does not open with words', () => {
  // The first entry carries the assistant's name, so a reply that opens with
  // assistant text already has somewhere to put it.
  assert.deepEqual(kinds([text('done')]), ['item'])
  assert.deepEqual(kinds([tool('t1')]), ['header', 'item'])
  assert.deepEqual(kinds([thinking('hm')]), ['header', 'item'])
  // Nothing to attribute yet.
  assert.deepEqual(kinds([]), [])
})

test('an item is keyed by its own position, and a tool call by its id', () => {
  const items = [tool('t1'), text('reading'), thinking('hm')]
  const entries = entriesFor(items)

  // Header first, then the three items -- and the positions are the items'
  // own, so the text at items[1] is `pos:1` and not `pos:2`.
  assert.deepEqual(detailEntryKeys(entries, items), ['header', 'tool:t1', 'pos:1', 'pos:2'])
})

test('a background task is keyed by its own id, in a key space of its own', () => {
  // A task has a real identity -- the block it draws is upserted in place as
  // the task progresses -- so like a tool it must not be renumbered by its
  // neighbours coming and going. The namespace keeps a task and a tool that
  // happen to share an id string from becoming one key.
  const items = [task('bg1'), text('a'), tool('bg1')]
  const keys = detailEntryKeys(entriesFor(items), items)

  assert.deepEqual(keys, ['header', 'task:bg1', 'pos:1', 'tool:bg1'])
  assert.equal(new Set(keys).size, keys.length)
})

test('an item keeps its key whether or not a header sits in front of it', () => {
  // This is the property the fix exists for, and the one an index into
  // `entries` did not have. The same items, keyed once with a header present
  // and once without: every item must answer to the same key both times.
  const items = [text('reading'), tool('t1'), thinking('hm')]

  const withoutHeader = entriesFor(items)
  assert.equal(withoutHeader.length, items.length, 'these items must NOT get a header, or this proves nothing')

  const withHeaderEntries: DetailEntry[] = [{ kind: 'header' }, ...withoutHeader]

  assert.deepEqual(detailEntryKeys(withHeaderEntries, items).slice(1), detailEntryKeys(withoutHeader, items))
})

test('the two key spaces cannot collide', () => {
  // A tool whose id is the digit of another entry's position. Keyed by the bare
  // values these would be one key, and React would treat two different entries
  // as the same one.
  const items = [text('a'), tool('0')]
  const keys = detailEntryKeys(entriesFor(items), items)

  assert.deepEqual(keys, ['pos:0', 'tool:0'])
  assert.equal(new Set(keys).size, keys.length)
})

test('every entry gets exactly one key, in order', () => {
  // The component indexes into this list by the entry's own position, so a
  // length that did not match would silently key entries with someone else's
  // key or with nothing at all.
  const items = [tool('t1'), text('a'), tool('t2'), thinking('b')]
  const entries = entriesFor(items)

  assert.equal(detailEntryKeys(entries, items).length, entries.length)
})
