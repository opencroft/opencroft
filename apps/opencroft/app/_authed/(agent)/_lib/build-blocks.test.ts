import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDelivery, encodeBatch, type TaggedMessage } from 'agent-client/queue-tags'
import type { QueuedPrompt } from 'agent-client/types'

import { type Block, buildBlocks, buildUnread, headerFromWindow, userText } from './build-blocks'
import type { ChatMessage } from './messages'

function userMessage(id: number, text: string): ChatMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }], timestamp: 0 }
}

function assistantMessage(id: number, text: string): ChatMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }], timestamp: 0 }
}

test('a user block takes the id of its own message', () => {
  const blocks = buildBlocks([userMessage(5, 'hi')])
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['u:5'],
  )
})

test('a details block is named by its turn, not by whichever reply comes first', () => {
  const blocks = buildBlocks([userMessage(0, 'q'), assistantMessage(1, 'a'), assistantMessage(2, 'more')])
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['u:0', 't:0'],
  )
})

test('the two kinds never collide, though a turn shares its id with its question', () => {
  // A turn's identity IS its user message's id, so without distinct namespaces
  // the question and its replies would carry the same React key in one list.
  const blocks = buildBlocks([userMessage(7, 'q'), assistantMessage(8, 'a')])
  assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length)
})

test('a page landing mid-turn does not rename the block it merges into', () => {
  // The regression this fixes. Record-granularity pages can land inside a turn,
  // and consecutive replies fold into one block — so a block named after its
  // first reply would be renamed by every such page, remounting it and losing
  // the scroll anchor. Named after the turn, it survives.
  const loaded = [assistantMessage(20, 'reply c'), assistantMessage(21, 'reply d')]
  const before = buildBlocks(loaded, 9)
  const after = buildBlocks([assistantMessage(18, 'reply a'), assistantMessage(19, 'reply b'), ...loaded], 9)
  assert.deepEqual(
    before.map((b) => b.id),
    ['t:9'],
  )
  assert.deepEqual(
    after.map((b) => b.id),
    ['t:9'],
  )
})

test('without an enclosing turn the leading run falls back to its first reply', () => {
  // Only reachable at the true start of history, where nothing can be prepended
  // — so the id cannot be invalidated by a later fetch.
  const blocks = buildBlocks([assistantMessage(3, 'a'), assistantMessage(4, 'b')])
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['t:3'],
  )
})

test('the enclosing turn names only the leading run, not later ones', () => {
  const blocks = buildBlocks(
    [assistantMessage(11, 'tail of turn 9'), userMessage(12, 'q'), assistantMessage(13, 'a')],
    9,
  )
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['t:9', 'u:12', 't:12'],
  )
})

test('block ids for already-rendered content are unaffected by a prepend, unlike array position', () => {
  // Mirrors the real flow: fold() assigns ids from the server-side absolute
  // event index (see fold.test.ts), so a "load older" prepend produces
  // messages with LOWER ids than anything already loaded — never a shift of
  // existing ids. Emulate that here directly on messages.
  const before = buildBlocks([userMessage(10, 'q1'), assistantMessage(11, 'a1')])
  const after = buildBlocks([
    userMessage(5, 'q0'),
    assistantMessage(6, 'a0'),
    userMessage(10, 'q1'),
    assistantMessage(11, 'a1'),
  ])
  // The blocks present before the prepend keep the exact same ids after it —
  // this is what makes the React key stable across a "load older" fetch
  // (position-derived keys broke this,
  // which broke the scroll-position restore).
  const beforeIds = before.map((b) => b.id)
  const afterTailIds = after.slice(-beforeIds.length).map((b) => b.id)
  assert.deepEqual(afterTailIds, beforeIds)
  // And the new content lands with ids that are NOT already in use.
  const afterHeadIds = after.slice(0, after.length - beforeIds.length).map((b) => b.id)
  assert.equal(new Set([...beforeIds, ...afterHeadIds]).size, beforeIds.length + afterHeadIds.length)
})

// ---------------------------------------------------------------------------
// One transformation, and the two paths that must agree on it.
//
// The bug: the sticky header for a partly-loaded turn read its text
// straight off the stream event, so that one turn — the first one a reader
// looks at — showed system tags no other message shows.
// ---------------------------------------------------------------------------

const REMINDER = '<opencroft-reminder>internal</opencroft-reminder>'

test('a user message shows its own words, not what the app added on the way out', () => {
  assert.equal(userText(`${REMINDER}what is this?`), 'what is this?')
})

test('a message that is nothing but tags has no words at all', () => {
  // Null rather than an empty string, so a caller has to decide what "nothing
  // to show" means instead of rendering an empty box by accident.
  assert.equal(userText(REMINDER), null)
  assert.equal(userText('   '), null)
})

test('the header and the bubble strip identically — that is the whole bug', () => {
  const raw = `${REMINDER}what is this?`
  const header = headerFromWindow({ index: 3, event: { kind: 'user', text: raw } })
  const bubble = buildBlocks([userMessage(3, raw)])[0]
  assert.equal(header?.text, bubble?.kind === 'user' ? bubble.text : undefined)
})

// The delivery-time stamp (message-envelope.ts's stampDeliveryTime) uses this
// same generic tag family, so it strips through the identical path — both the
// 1:1 chat bubble and, since group-chat threads render through this same
// component, the group-chat surface too.
test('a delivery-time stamp strips like any other opencroft tag', () => {
  const raw = '<opencroft-time>07.08.2026 19:15:42</opencroft-time>\nwhat time is it?'
  assert.equal(userText(raw), 'what time is it?')
})

// ---------------------------------------------------------------------------
// What is waiting to be read: the same strip a delivered message gets, plus
// the two fields only a message has.
// ---------------------------------------------------------------------------

function waiting(id: string, sender: string, sentAt: string, text: string): QueuedPrompt {
  return { id, kind: 'message', sender, sentAt, text }
}

test('a message waiting to be read keeps its author and its send time', () => {
  assert.deepEqual(
    buildUnread([waiting('q1', 'Alex Rivera', '2026-03-04T09:12:00.000Z', `${REMINDER}check the build first`)]),
    [{ id: 'q1', text: 'check the build first', sender: 'Alex Rivera', sentAt: '2026-03-04T09:12:00.000Z' }],
  )
})

test('a system prompt waiting to be read has no author and no send time', () => {
  // Absent, not blank. Nobody sent it, and an empty name renders as a nameless
  // author rather than as no author at all.
  assert.deepEqual(buildUnread([{ id: 'q2', kind: 'system', text: '/compact' }]), [
    { id: 'q2', text: '/compact', sender: undefined, sentAt: undefined },
  ])
})

test('a waiting message that is nothing but tags keeps its row', () => {
  // Empty words rather than a missing row: it is still being held and can
  // still be taken back, and a row nobody draws is one nobody can remove.
  assert.deepEqual(buildUnread([waiting('q3', 'Priya Raman', '2026-03-04T09:40:00.000Z', REMINDER)]), [
    { id: 'q3', text: '', sender: 'Priya Raman', sentAt: '2026-03-04T09:40:00.000Z' },
  ])
})

test('the queue renders in the order it is held in', () => {
  const built = buildUnread([
    waiting('q1', 'Alex Rivera', '2026-03-04T09:12:00.000Z', 'first'),
    { id: 'q2', kind: 'system', text: '/compact' },
    waiting('q3', 'Priya Raman', '2026-03-04T09:40:00.000Z', 'third'),
  ])
  assert.deepEqual(
    built.map((m) => m.id),
    ['q1', 'q2', 'q3'],
  )
})

test('a header keeps its index even when its text strips to nothing', () => {
  // The trap in this fix. The header carries two things and only one of them is
  // presentational: `index` names the enclosing turn, which is what stops the
  // leading details block being renamed by every mid-turn page. Dropping
  // the whole header because its words vanished would reintroduce that
  // regression by way of a cosmetic rule.
  const header = headerFromWindow({ index: 42, event: { kind: 'user', text: REMINDER } })
  assert.equal(header?.index, 42)
  assert.equal(header?.text, null, 'no words to show as a header')
})

test('a window that starts at a turn boundary has no header at all', () => {
  assert.equal(headerFromWindow(undefined), null)
  assert.equal(headerFromWindow(null), null)
})

test('a non-user event is never a header', () => {
  // The header names the QUESTION a partly-loaded turn hangs from; anything
  // else arriving in that slot would render an agent reply as a user bubble.
  assert.equal(headerFromWindow({ index: 1, event: { kind: 'agent_message', text: 'a reply' } }), null)
})

// ---------------------------------------------------------------------------
// A turn read back into the messages it carried.
//
// The transcript is the only place those messages are ever seen apart again: a
// session reload replays a whole turn as one text with no metadata of its own,
// so the tags inside it are the only surviving record of who wrote what, when.
//
// Built through the real encoder rather than from hand-written tag lines, so
// these describe the pipeline and not a copy of the format.
// ---------------------------------------------------------------------------

function sent(sender: string, sentAt: string, text: string): TaggedMessage {
  return { sender, sentAt, text }
}

function partsOf(block?: Block) {
  return block?.kind === 'user' ? block.parts : null
}

test('an untagged message is one part, with no author and no send time', () => {
  // Every message written before the format existed, still sitting in
  // transcripts that get replayed. Absent, not blank: nothing is known about
  // who sent it, and inventing a value would be worse than admitting that.
  assert.deepEqual(partsOf(buildBlocks([userMessage(1, 'what changed?')])[0]), [
    { text: 'what changed?', author: undefined, sentAt: undefined },
  ])
})

test('a tagged message shows its words without the tag that carried them', () => {
  const raw = encodeBatch([sent('Alex Rivera', '2026-03-04T09:12:00.000Z', 'what changed?')])
  assert.deepEqual(partsOf(buildBlocks([userMessage(1, raw)])[0]), [
    { text: 'what changed?', author: 'Alex Rivera', sentAt: '2026-03-04T09:12:00.000Z' },
  ])
})

test('a turn that carried several messages keeps every author and every send time', () => {
  const raw = encodeBatch([
    sent('Alex Rivera', '2026-03-04T09:12:00.000Z', 'look at the nightly import job'),
    sent('Alex Rivera', '2026-03-04T09:13:40.000Z', 'it started after the schema change'),
    sent('Sam Okonkwo', '2026-03-04T09:15:05.000Z', 'it runs fine on the smaller dataset'),
  ])
  assert.deepEqual(partsOf(buildBlocks([userMessage(1, raw)])[0]), [
    { text: 'look at the nightly import job', author: 'Alex Rivera', sentAt: '2026-03-04T09:12:00.000Z' },
    { text: 'it started after the schema change', author: 'Alex Rivera', sentAt: '2026-03-04T09:13:40.000Z' },
    { text: 'it runs fine on the smaller dataset', author: 'Sam Okonkwo', sentAt: '2026-03-04T09:15:05.000Z' },
  ])
})

test('a turn that carried several messages is still ONE user block', () => {
  // The constraint the whole design turns on. A fork rewinds to a turn index
  // counted as the ordinal of user blocks, so splitting one delivery across
  // three blocks would shift every later turn index and rewind to the wrong
  // turn — destructive, and with nothing on screen to notice it by.
  const raw = encodeBatch([
    sent('Alex Rivera', '2026-03-04T09:12:00.000Z', 'first'),
    sent('Alex Rivera', '2026-03-04T09:13:00.000Z', 'second'),
  ])
  const blocks = buildBlocks([userMessage(1, raw), assistantMessage(2, 'a'), userMessage(3, 'a later question')])
  assert.deepEqual(
    blocks.filter((b) => b.kind === 'user').map((b) => b.id),
    ['u:1', 'u:3'],
  )
})

test('an edit hands back the whole turn, tags and all', () => {
  // `text` is what fills the composer, so it stays exactly as delivered. The
  // tags are how each message's author and send time survive a reload, so a
  // re-send that dropped them would lose them for good — which is why the
  // composer shows them rather than the words alone.
  const raw = encodeBatch([
    sent('Alex Rivera', '2026-03-04T09:12:00.000Z', 'first'),
    sent('Sam Okonkwo', '2026-03-04T09:13:00.000Z', 'second'),
  ])
  const block = buildBlocks([userMessage(1, raw)])[0]
  assert.equal(block?.kind === 'user' ? block.text : null, raw)
})

test('the note on an interrupted delivery is not part of the conversation', () => {
  // It is addressed to the agent and sits ahead of the first tag, which is
  // exactly what the parser drops. A reader must never see it attributed to
  // whoever's message it happened to arrive in front of.
  const raw = buildDelivery({
    kind: 'messages',
    note: 'queue-jump',
    messages: [sent('Alex Rivera', '2026-03-04T09:12:00.000Z', 'stop and read this')],
  })
  assert.deepEqual(partsOf(buildBlocks([userMessage(1, raw)])[0]), [
    { text: 'stop and read this', author: 'Alex Rivera', sentAt: '2026-03-04T09:12:00.000Z' },
  ])
})

test('one message of a turn stripping to nothing costs that message its bubble, not the turn', () => {
  const raw = encodeBatch([
    sent('Alex Rivera', '2026-03-04T09:12:00.000Z', REMINDER),
    sent('Sam Okonkwo', '2026-03-04T09:13:00.000Z', 'the one with words in it'),
  ])
  assert.deepEqual(partsOf(buildBlocks([userMessage(1, raw)])[0]), [
    { text: 'the one with words in it', author: 'Sam Okonkwo', sentAt: '2026-03-04T09:13:00.000Z' },
  ])
})

test('a turn whose every message strips to nothing draws no bubble, and still ends the run', () => {
  const raw = encodeBatch([sent('Alex Rivera', '2026-03-04T09:12:00.000Z', REMINDER)])
  const blocks = buildBlocks([userMessage(1, raw), assistantMessage(2, 'a')])
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['t:1'],
  )
})
