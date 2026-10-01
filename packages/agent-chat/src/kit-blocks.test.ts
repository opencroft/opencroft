// Pins that a tool call's reported file changes reach the detail item a host's
// tool renderer is handed: a harness may report the change there and nowhere
// else, and a builder that drops it leaves the view nothing to draw.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from 'agent-client/fold'

import { buildKitBlocks } from './kit-blocks'

const toolItems = (messages: ChatMessage[]) =>
  buildKitBlocks(messages).flatMap((block) =>
    'items' in block ? block.items.filter((item) => item.kind === 'tool') : [],
  )

test("a tool call's reported diffs are carried onto its detail item", () => {
  const diffs = [{ path: '/tmp/a.txt', oldText: 'one', newText: 'two' }]
  const [item] = toolItems([
    { id: 'u', kind: 'user', text: 'go' },
    { id: 't', kind: 'tool', toolCallId: 'c1', title: 'Edit', status: 'completed', input: {}, diffs },
  ])
  assert.ok(item && item.kind === 'tool')
  assert.deepEqual(item.diffs, diffs)
})

test('a tool call that reported no diffs gets no diffs key', () => {
  const [item] = toolItems([
    { id: 'u', kind: 'user', text: 'go' },
    { id: 't', kind: 'tool', toolCallId: 'c1', title: 'ls', status: 'completed', input: {} },
  ])
  assert.ok(item && !('diffs' in item))
})
