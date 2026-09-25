// The rules of an open turn edit that decide what the reader can do: what a
// reset restores, when an empty composer may still commit, and what a commit
// sends -- for a message's words and for its pictures.
import assert from 'node:assert/strict'
import test from 'node:test'

import { changedEdits, editSlot, hasContent, originalDrafts, originalPictures, othersHaveContent } from './edit-drafts'
import type { ComposerPicture, PictureSlots } from './use-composer-pictures'
import type { EditablePart } from './user-parts'

const SHOT = { id: 'shot-1', name: 'shot.png', src: '/shot-1' }

const PARTS: EditablePart[] = [
  { index: 0, text: 'first', pictures: [] },
  { index: 1, text: 'second', pictures: [SHOT] },
  { index: 2, text: 'third', pictures: [] },
]

const ready = (id: string): ComposerPicture => ({ key: `k-${id}`, id, name: `${id}.png`, uploading: false })
const failed: ComposerPicture = { key: 'k-bad', name: 'bad.png', uploading: false, error: 'too big' }

// The slots exactly as an opened edit seeds them: every message's delivered
// pictures, nothing changed.
const seeded = (): PictureSlots => ({
  [editSlot(0)]: [],
  [editSlot(1)]: [ready(SHOT.id)],
  [editSlot(2)]: [],
})

test('a reset restores every message of the turn, words and pictures, not only the one on screen', () => {
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
  assert.deepEqual(originalPictures(PARTS), { [editSlot(0)]: [], [editSlot(1)]: [SHOT], [editSlot(2)]: [] })
  // After a reset nothing is left to commit.
  assert.deepEqual(changedEdits(PARTS, originalDrafts(PARTS), seeded()), [])
})

test('a message has content while it has words or a picture that will travel', () => {
  assert.equal(hasContent('words', []), true)
  assert.equal(hasContent('  ', [ready('a')]), true, 'a picture alone is content')
  assert.equal(hasContent('', [{ ...ready('a'), id: undefined, uploading: true }]), true, 'an upload in flight counts')
  assert.equal(hasContent('', [failed]), false, 'a failed picture will not travel')
  assert.equal(hasContent(' \n', undefined), false)
})

test('an empty composer may commit while another message still has words or pictures', () => {
  const drafts = new Map([
    [0, ''],
    [1, ''],
    [2, '  '],
  ])
  // Open on message 0: message 1's words are gone, but its picture is not.
  assert.equal(othersHaveContent(PARTS, drafts, seeded(), PARTS[0]), true)
  // Open on message 1 itself: nothing ELSE has anything.
  assert.equal(othersHaveContent(PARTS, drafts, seeded(), PARTS[1]), false)
})

test('an empty composer may not commit once every message has nothing', () => {
  const drafts = new Map([
    [0, ''],
    [1, ' \n'],
    [2, ''],
  ])
  const empty: PictureSlots = { [editSlot(1)]: [failed] }
  for (const open of PARTS) {
    assert.equal(othersHaveContent(PARTS, drafts, empty, open), false, `open on ${open.index}`)
  }
  // A single-message turn has no other message to commit.
  const one = [PARTS[0]]
  assert.equal(othersHaveContent(one, originalDrafts(one), {}, one[0]), false)
})

test('an emptied message is committed as empty words, and an unchanged one not at all', () => {
  const drafts = new Map([
    [0, 'first'],
    [1, 'second'],
    [2, ''],
  ])
  assert.deepEqual(changedEdits(PARTS, drafts, seeded()), [{ index: 2, text: '' }])
})

test('a picture added, removed or failed changes the message, and sends its complete list', () => {
  const drafts = originalDrafts(PARTS)
  // Added to message 0, removed from message 1, a failed one on message 2.
  const slots: PictureSlots = {
    [editSlot(0)]: [ready('new')],
    [editSlot(1)]: [],
    [editSlot(2)]: [failed],
  }
  assert.deepEqual(changedEdits(PARTS, drafts, slots), [
    { index: 0, text: 'first', attachments: ['new'] },
    { index: 1, text: 'second', attachments: [] },
  ])
})

test('words and pictures both cleared go as exactly that, which the host reads as removal', () => {
  const drafts = new Map([
    [0, 'first'],
    [1, ''],
    [2, 'third'],
  ])
  assert.deepEqual(changedEdits(PARTS, drafts, { ...seeded(), [editSlot(1)]: [] }), [
    { index: 1, text: '', attachments: [] },
  ])
})
