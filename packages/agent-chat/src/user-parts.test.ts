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

import type { UserText } from './components/chat-turn'
import { toEditableParts, toUserParts } from './user-parts'

const msg = (sender: string, sentAt: string, text: string): TaggedMessage => ({ sender, sentAt, text })
const T1 = '2026-08-21T01:00:00.000Z'
const T2 = '2026-08-21T01:01:00.000Z'
const T3 = '2026-08-21T01:02:00.000Z'

// A host's own last step from a raw message to the words a reader sees -- the
// same seam a host fills with its own stripper for whatever tags it puts in a
// message. A message that is nothing but context renders nothing at all.
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
    { index: 0, text: 'first', pictures: [] },
    { index: 2, text: 'third', pictures: [] },
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
    { index: 0, text: 'from before the format existed', pictures: [] },
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
    { index: 0, text: 'first', pictures: [] },
    { index: 1, text: 'second', pictures: [] },
  ])
  assert.equal(
    parts.some((part) => part.text.includes('Your turn was interrupted')),
    false,
    'the note is nobody’s message and is never handed over as one',
  )
})

// ---------------------------------------------------------------------------
// Who a message is from, and who that turns out to be
// ---------------------------------------------------------------------------

// The same rendering seam `toEditableParts` uses, wearing the brand that
// `toUserParts` asks for. The brand exists so no renderer can be handed an
// unstripped string; a test standing in for a host has to satisfy it too.
const show = (raw: string): UserText | null => render(raw) as UserText | null

test('a message carries the account its identifier resolves to, per message', () => {
  // The reason resolution is per message rather than per turn: one delivery is
  // not one person's words. Two senders in one turn must produce two faces.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('ada', T1, 'first'), msg('bo', T2, 'second')],
  })

  const parts = toUserParts(turn, show, {
    ada: { name: 'Ada L', avatarUrl: '/ada.png' },
    bo: { name: 'Bo', avatarUrl: null },
  })

  assert.deepEqual(
    parts.map((part) => part.authorAccount),
    [
      { name: 'Ada L', avatarUrl: '/ada.png' },
      { name: 'Bo', avatarUrl: null },
    ],
  )
})

test('the identifier is kept beside the account it resolved to, not replaced by it', () => {
  // `author` is what the delivery durably says; `authorAccount` is what that
  // means today. Dropping the first would make the second unfalsifiable.
  const turn = buildDelivery({ kind: 'messages', messages: [msg('ada', T1, 'first')] })

  const [part] = toUserParts(turn, show, { ada: { name: 'Ada L' } })

  assert.equal(part?.author, 'ada')
  assert.deepEqual(part?.authorAccount, { name: 'Ada L' })
})

test('an identifier nothing resolves is left unresolved rather than given a placeholder', () => {
  // Every message stamped before accounts had handles lands here, and so does
  // one whose account has since been deleted. The header draws that state; a
  // placeholder would turn "we do not know" into a picture of somebody.
  const turn = buildDelivery({ kind: 'messages', messages: [msg('Alice', T1, 'first')] })

  const [part] = toUserParts(turn, show, { ada: { name: 'Ada L' } })

  assert.equal(part?.author, 'Alice')
  assert.equal(part?.authorAccount, undefined)
  assert.ok(!('authorAccount' in (part ?? {})), 'absent, not present and empty')
})

test('a host that resolves nothing at all gets exactly what it got before', () => {
  // The optional argument has to be genuinely optional: a host with no notion
  // of accounts passes nothing and its parts are unchanged.
  const turn = buildDelivery({ kind: 'messages', messages: [msg('ada', T1, 'first')] })

  assert.deepEqual(toUserParts(turn, show), [{ text: 'first', author: 'ada', sentAt: T1 }])
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
    { index: 0, text: 'restart it', pictures: [] },
    { index: 1, text: 'second', pictures: [] },
  ])
})

test('a message with no words is still a stop when it carried a picture, and its pictures ride on it', () => {
  // Nothing to read, but something to take off: skipping it would leave the
  // picture with no place in the editor.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('Alice', T1, 'first'), msg('Alice', T2, '<ctx>selection: node-1</ctx>'), msg('Bob', T3, 'third')],
  })
  const shot = { id: 'shot-1', name: 'shot.png', src: '/shot-1', message: 1 }

  assert.deepEqual(toEditableParts(turn, render, [shot]), [
    { index: 0, text: 'first', pictures: [] },
    { index: 1, text: '', pictures: [{ id: 'shot-1', name: 'shot.png', src: '/shot-1' }] },
    { index: 2, text: 'third', pictures: [] },
  ])
})

// ---------------------------------------------------------------------------
// What travelled beside the words
// ---------------------------------------------------------------------------

test("what travelled is asked for by the message's place in the delivery, skipped messages counted", () => {
  // A host that keeps pictures beside the text matches them to messages by
  // position, so the position has to be the delivery's own -- the context-only
  // message in the middle still holds its place.
  const turn = buildDelivery({
    kind: 'messages',
    messages: [msg('ada', T1, 'first'), msg('ada', T2, '<ctx>selection: node-1</ctx>'), msg('bo', T3, 'third')],
  })
  const asked: number[] = []
  const parts = toUserParts(turn, show, undefined, (_raw, index) => {
    asked.push(index)
    return index === 2 ? [{ label: 'shot.png' }] : []
  })
  assert.deepEqual(asked, [0, 1, 2])
  assert.deepEqual(
    parts.map((part) => part.attachments?.map((attachment) => attachment.label)),
    [undefined, ['shot.png']],
  )
})

test('a message with no words is kept when something travelled with it', () => {
  // A picture sent on its own is a message; dropping it for having no words
  // would lose the one thing it said.
  const turn = buildDelivery({ kind: 'messages', messages: [msg('ada', T1, ''), msg('ada', T2, 'and words')] })
  const parts = toUserParts(turn, show, undefined, (_raw, index) => (index === 0 ? [{ label: 'shot.png' }] : []))
  assert.deepEqual(
    parts.map((part) => [part.text, part.attachments?.length ?? 0]),
    [
      ['', 1],
      ['and words', 0],
    ],
  )
})
