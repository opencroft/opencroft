// The numbering a commit is keyed on.
//
// `toEditableParts` decides which messages of a delivered turn a reader can
// edit, and what each one's position is. Those positions are what a host sends
// back when it commits, so a message that is skipped must not shift the ones
// after it: the delivery's own numbering is the only numbering the stored turn
// is in, and an index that quietly slid by one writes the reader's words into
// somebody else's message.
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDelivery, type TaggedMessage } from 'agent-client/queue-tags'

import { toEditableParts } from './user-parts'

const msg = (sender: string, sentAt: string, text: string): TaggedMessage => ({ sender, sentAt, text })
const T1 = '2026-08-21T01:00:00.000Z'
const T2 = '2026-08-21T01:01:00.000Z'
const T3 = '2026-08-21T01:02:00.000Z'

// A host's own last step from a raw message to the words a reader sees --
// the same seam the OpenCroft app fills with its `<opencroft-*>` stripper.
// A message that is nothing but context renders nothing at all.
const render = (raw: string): string | null => {
  const stripped = raw.replace(/<ctx>[\s\S]*?<\/ctx>\s*/g, '')
  return stripped.trim() ? stripped : null
}

test('a message that renders nothing is skipped, and the ones after it keep the delivery numbering', () => {
  // The invariant this module exists to hold: the third message is at 2, not at
  // 1. Renumbering the survivors would commit the reader's edit of "third" into
  // the context-only message sitting between them.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('Alice', T1, 'first'), msg('Alice', T2, '<ctx>selection: node-1</ctx>'), msg('Bob', T3, 'third')],
  })

  assert.deepEqual(toEditableParts(turn, render), [
    { index: 0, text: 'first' },
    { index: 2, text: 'third' },
  ])
})

test('a turn with nothing anybody wrote yields no editable messages at all', () => {
  // The host's signal to open no editor rather than an empty one.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('Alice', T1, '<ctx>selection: node-1</ctx>')],
  })

  assert.deepEqual(toEditableParts(turn, render), [])
})

test('an untagged turn is one editable message at position 0', () => {
  // Every message written before the tag format existed, still sitting in
  // transcripts that get replayed. It decodes to one part, and editing it
  // replaces the whole prompt -- which is what an untagged turn IS.
  assert.deepEqual(toEditableParts('from before the format existed', render), [
    { index: 0, text: 'from before the format existed' },
  ])
})

test('the interrupt note is not a message and does not shift the numbering', () => {
  // It precedes the first tag, so the decode drops it -- and it must not become
  // a position, or every message in an interrupted turn would commit one place
  // off. It is put back verbatim by whoever rebuilds the turn, not by this.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('Alice', T1, 'first'), msg('Bob', T2, 'second')],
    note: 'queue-jump',
  })

  const parts = toEditableParts(turn, render)
  assert.deepEqual(parts, [
    { index: 0, text: 'first' },
    { index: 1, text: 'second' },
  ])
  assert.equal(
    parts.some((part) => part.text.includes('Your turn was interrupted')),
    false,
    'the note is nobody’s message and is never handed over as one',
  )
})

test('the host renders each message on its own, never the delivery as a whole', () => {
  // Why the seam is per message: a stripper run over the whole turn can take
  // the newline that keeps the next tag at the start of a line, and the decode
  // then finds fewer messages than the delivery has. Here the context sits
  // where a host actually puts it -- in front of the words it describes.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('Alice', T1, '<ctx>selection: node-1</ctx>\nrestart it'), msg('Bob', T2, 'second')],
  })

  assert.deepEqual(toEditableParts(turn, render), [
    { index: 0, text: 'restart it' },
    { index: 1, text: 'second' },
  ])
})
