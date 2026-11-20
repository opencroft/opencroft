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

test("a new session and a completed compaction each draw a rule where the agent's context restarts", () => {
  const blocks = buildKitBlocks([
    { id: '1', kind: 'user', text: 'first' },
    { id: '2', kind: 'assistant', text: 'one' },
    { id: '3', kind: 'session_start' },
    { id: '4', kind: 'user', text: 'second' },
    { id: '5', kind: 'tool', toolCallId: 'compaction:k1', title: 'Compact conversation', status: 'completed' },
    { id: '6', kind: 'assistant', text: 'two' },
    { id: '7', kind: 'tool', toolCallId: 'compaction:k2', title: 'Compact conversation', status: 'failed' },
  ])
  assert.deepEqual(
    blocks.map((block) => (block.kind === 'context-start' ? `${block.id} (${block.reason})` : block.id)),
    ['u:1', 't:2', 'c:3 (new-session)', 'u:4', 't:5', 'c:5 (compaction)', 't:6'],
  )
})

test('rules with nothing between them draw as one, the last', () => {
  const blocks = buildKitBlocks([
    { id: '1', kind: 'user', text: 'first' },
    { id: '2', kind: 'assistant', text: 'one' },
    { id: '3', kind: 'session_start' },
    { id: '4', kind: 'session_start' },
    { id: '5', kind: 'assistant', text: '' },
    { id: '6', kind: 'session_start' },
    { id: '7', kind: 'user', text: 'second' },
  ])
  assert.deepEqual(
    blocks.map((block) => (block.kind === 'context-start' ? `${block.id} (${block.reason})` : block.id)),
    ['u:1', 't:2', 'c:6 (new-session)', 'u:7'],
  )
})

test("a tool call's kept media reaches its result with the host's URL, and with none from a host that gives none", () => {
  const messages: ChatMessage[] = [
    { id: 'u', kind: 'user', text: 'go' },
    {
      id: 't',
      kind: 'tool',
      toolCallId: 'c1',
      title: 'screenshot',
      status: 'completed',
      input: {},
      output: 'shot\n[image]',
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', mimeType: 'image/png', byteSize: 4, mediaId: 'm-1', width: 2, height: 1 },
      ],
    },
  ]
  const withUrls = buildKitBlocks(messages, { mediaSrc: (id) => `/media/${id}` }).flatMap((block) =>
    'items' in block ? block.items : [],
  )
  const tool = withUrls.find((item) => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.deepEqual(tool.result?.content, [
    { type: 'text', text: 'shot' },
    { type: 'image', mimeType: 'image/png', byteSize: 4, src: '/media/m-1', width: 2, height: 1 },
  ])
  const [bare] = toolItems(messages)
  assert.ok(bare && bare.kind === 'tool')
  assert.deepEqual(bare.result?.content?.[1], { type: 'image', mimeType: 'image/png', byteSize: 4, width: 2, height: 1 })
})

test('a tool call that reported no diffs gets no diffs key', () => {
  const [item] = toolItems([
    { id: 'u', kind: 'user', text: 'go' },
    { id: 't', kind: 'tool', toolCallId: 'c1', title: 'ls', status: 'completed', input: {} },
  ])
  assert.ok(item && !('diffs' in item))
})
