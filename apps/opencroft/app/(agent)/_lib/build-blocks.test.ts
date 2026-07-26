import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBlocks } from './build-blocks'
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
