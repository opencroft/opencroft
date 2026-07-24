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
    [5],
  )
})

test('a details block takes the id of the FIRST message in its chain, not the last', () => {
  const blocks = buildBlocks([userMessage(0, 'q'), assistantMessage(1, 'a'), assistantMessage(2, 'more')])
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].id, 0)
  assert.equal(blocks[1].id, 1)
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
