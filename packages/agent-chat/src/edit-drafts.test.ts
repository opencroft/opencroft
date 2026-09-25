// The rules of an open turn edit that decide what the reader can do: what a
// reset restores, when an empty composer may still commit, and what a commit
// sends for a message the reader emptied.
import assert from 'node:assert/strict'
import test from 'node:test'

import { changedEdits, originalDrafts, othersHaveText } from './edit-drafts'
import type { EditablePart } from './user-parts'

const PARTS: EditablePart[] = [
  { index: 0, text: 'first' },
  { index: 1, text: 'second' },
  { index: 2, text: 'third' },
]

test('a reset restores every message of the turn, not only the one on screen', () => {
  // The drafts after the reader changed two messages and emptied the third.
  const edited = new Map([
    [0, 'first, rewritten'],
    [1, ''],
    [2, 'third, rewritten'],
  ])
  assert.notDeepEqual(edited, originalDrafts(PARTS), 'precondition: the drafts differ from the turn')
  assert.deepEqual(
    originalDrafts(PARTS),
    new Map([
      [0, 'first'],
      [1, 'second'],
      [2, 'third'],
    ]),
  )
  // After a reset nothing is left to commit.
  assert.deepEqual(changedEdits(PARTS, originalDrafts(PARTS)), [])
})

test('an empty composer may commit while another message still has words', () => {
  const drafts = new Map([
    [0, ''],
    [1, 'second'],
    [2, '  '],
  ])
  // Open on an emptied message; message 1 still has words.
  assert.equal(othersHaveText(PARTS, drafts, PARTS[0]), true)
  // Open on the only message with words: every OTHER message is empty.
  assert.equal(othersHaveText(PARTS, drafts, PARTS[1]), false)
})

test('an empty composer may not commit once every message is empty', () => {
  const drafts = new Map([
    [0, ''],
    [1, ' \n'],
    [2, ''],
  ])
  for (const open of PARTS) {
    assert.equal(othersHaveText(PARTS, drafts, open), false, `open on ${open.index}`)
  }
  // A single-message turn has no other message to commit.
  assert.equal(othersHaveText([PARTS[0]], originalDrafts([PARTS[0]]), PARTS[0]), false)
})

test('an emptied message is committed as empty words, and an unchanged one not at all', () => {
  const drafts = new Map([
    [0, 'first'],
    [1, ''],
    [2, 'third, rewritten'],
  ])
  assert.deepEqual(changedEdits(PARTS, drafts), [
    { index: 1, text: '' },
    { index: 2, text: 'third, rewritten' },
  ])
})
