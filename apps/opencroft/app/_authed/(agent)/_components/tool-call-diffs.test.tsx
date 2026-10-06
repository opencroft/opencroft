// The whole road a reported file change takes to the transcript: the events a
// session stores, folded into chat parts, built into the turn's detail items,
// and drawn by the transcript's own tool renderer. Each hop is a place the
// change can be dropped while every hop's own tests still pass.
//
// The events have the shape claude-agent-acp 0.84.0 sends an Edit in to a
// client declaring the JetBrains AIR extension: the arguments name only the
// file, and the change is only in the reported diffs.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatEvent } from 'agent-client/types'
import { renderToStaticMarkup } from 'react-dom/server'

import { buildBlocks } from '@/app/_authed/(agent)/_lib/build-blocks'
import { renderToolCall } from './agent-chat'
import { fold } from './use-acp-session'

const lines = Array.from({ length: 40 }, (_, index) => `${index + 1}`)
const region = (at: number, replacement: string) => ({
  path: '/tmp/notes.txt',
  oldText: lines.slice(at - 4, at + 3).join('\n'),
  newText: [...lines.slice(at - 4, at - 1), replacement, ...lines.slice(at, at + 3)].join('\n'),
})

function renderedTool(events: ChatEvent[]): string {
  const { messages } = fold(events, 0)
  const items = buildBlocks(messages).flatMap((block) => (block.kind === 'details' ? block.items : []))
  const tool = items.find((item) => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool', 'the call reached the detail items')
  return renderToStaticMarkup(renderToolCall(tool))
}

const textOf = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '')

// A line's text may hold the spans that mark its changed words, so it runs to
// the end of its row rather than to the first closing tag.
const markedLines = (html: string) =>
  [...html.matchAll(/<span class="sr-only">(added|removed): <\/span><span[^>]*>(.*?)<\/span><\/div>/g)].map(
    ([, kind, text]) => `${kind === 'added' ? '+' : '-'} ${text.replace(/<[^>]*>/g, '')}`,
  )

test('an Edit reported only as diffs is drawn as those diffs in the transcript', () => {
  const html = renderedTool([
    { kind: 'user', text: 'change lines 5 and 30' },
    { kind: 'tool_call', toolCallId: 'e1', title: 'Edit', status: 'pending', name: 'Edit' },
    {
      kind: 'tool_update',
      toolCallId: 'e1',
      title: 'Edit /tmp/notes.txt',
      input: { file_path: '/tmp/notes.txt', replace_all: false },
      diffs: [region(5, 'LINE FIVE CHANGED'), region(30, 'LINE THIRTY CHANGED')],
    },
    // The tool's own answer arrives last, as text: it must not retract the change.
    { kind: 'tool_update', toolCallId: 'e1', status: 'completed', output: 'The file has been updated.' },
  ])
  assert.deepEqual(markedLines(html), ['- 5', '+ LINE FIVE CHANGED', '- 30', '+ LINE THIRTY CHANGED'])
  assert.ok(textOf(html).includes('+2 −2'))
  assert.ok(!textOf(html).includes('The change is not in the transcript.'))
})

test('a Write reported without a before side is drawn as a new file, every line added', () => {
  const html = renderedTool([
    { kind: 'user', text: 'write it' },
    {
      kind: 'tool_call',
      toolCallId: 'w1',
      title: 'Write /tmp/notes.txt',
      status: 'pending',
      name: 'Write',
      input: { file_path: '/tmp/notes.txt' },
      diffs: [{ path: '/tmp/notes.txt', oldText: null, newText: 'first\nsecond' }],
    },
    { kind: 'tool_update', toolCallId: 'w1', status: 'completed', output: 'ok' },
  ])
  assert.deepEqual(markedLines(html), ['+ first', '+ second'])
  assert.ok(textOf(html).includes('+2 −0'))
})

test('a Write whose post-write report carries the before side is drawn as that diff', () => {
  const html = renderedTool([
    { kind: 'user', text: 'write it' },
    {
      kind: 'tool_call',
      toolCallId: 'w1',
      title: 'Write /tmp/notes.txt',
      status: 'pending',
      name: 'Write',
      input: { file_path: '/tmp/notes.txt' },
      diffs: [{ path: '/tmp/notes.txt', oldText: null, newText: 'first\nsecond, changed' }],
    },
    // The report that follows the write replaces the first one as a whole.
    {
      kind: 'tool_update',
      toolCallId: 'w1',
      diffs: [{ path: '/tmp/notes.txt', oldText: 'first\nsecond', newText: 'first\nsecond, changed' }],
    },
    { kind: 'tool_update', toolCallId: 'w1', status: 'completed', output: 'ok' },
  ])
  assert.deepEqual(markedLines(html), ['- second', '+ second, changed'])
  assert.ok(textOf(html).includes('+1 −1'))
})
