import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolCallContent } from '@agentclientprotocol/sdk'

import { toolContent, toolMedia } from './tool-content'

// 4 and 3 bytes of base64 payload: what the sizes below are read from.
const PICTURE = 'AAAAAA=='
const SOUND = 'AAAA'
const SKETCH = 'PHN2Zz4='

const wrapped = (content: Record<string, unknown>) => ({ type: 'content', content }) as ToolCallContent

const MIXED: ToolCallContent[] = [
  wrapped({ type: 'text', text: 'before' }),
  wrapped({ type: 'image', data: PICTURE, mimeType: 'image/png' }),
  { type: 'diff', path: 'a.txt', oldText: 'x', newText: 'y' } as ToolCallContent,
  wrapped({ type: 'audio', data: SOUND, mimeType: 'audio/wav' }),
  wrapped({ type: 'resource_link', uri: 'file:///srv/app/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 2048 }),
  wrapped({ type: 'resource', resource: { uri: 'file:///srv/app/notes.md', mimeType: 'text/markdown', text: '# Notes' } }),
  wrapped({ type: 'resource', resource: { uri: 'file:///srv/app/chart.png', mimeType: 'image/png', blob: PICTURE } }),
  wrapped({ type: 'resource', resource: { uri: 'file:///srv/app/data.bin', mimeType: 'application/octet-stream', blob: SOUND } }),
  { type: 'terminal', terminalId: 'term-1' } as ToolCallContent,
]

test('lists the pictures and sounds of a result in order, embedded blobs of those types included', () => {
  assert.deepEqual(toolMedia(MIXED, undefined), [
    { mimeType: 'image/png', data: PICTURE },
    { mimeType: 'audio/wav', data: SOUND },
    { mimeType: 'image/png', data: PICTURE },
  ])
})

test('keeps every part of a result in order, each piece of media with the answer stored for it', () => {
  const parts = toolContent(MIXED, undefined, [{ id: 'm-1', width: 2, height: 1 }, null, { id: 'm-3' }])
  assert.deepEqual(parts, [
    { type: 'text', text: 'before' },
    { type: 'image', mimeType: 'image/png', byteSize: 4, mediaId: 'm-1', width: 2, height: 1 },
    { type: 'audio', mimeType: 'audio/wav', byteSize: 3 },
    {
      type: 'resource_link',
      uri: 'file:///srv/app/report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
    },
    { type: 'resource', uri: 'file:///srv/app/notes.md', mimeType: 'text/markdown', text: '# Notes' },
    { type: 'image', mimeType: 'image/png', byteSize: 4, mediaId: 'm-3' },
    { type: 'resource', uri: 'file:///srv/app/data.bin', mimeType: 'application/octet-stream', byteSize: 3 },
    { type: 'terminal', terminalId: 'term-1' },
  ])
})

test('names no stored bytes for media nothing was stored for', () => {
  const parts = toolContent([wrapped({ type: 'image', data: SKETCH, mimeType: 'image/svg+xml' })], undefined)
  assert.deepEqual(parts, [{ type: 'image', mimeType: 'image/svg+xml', byteSize: 5 }])
})

test('has nothing to keep for a result of text and file changes alone', () => {
  const content = [
    wrapped({ type: 'text', text: 'done' }),
    { type: 'diff', path: 'a.txt', oldText: null, newText: 'y' } as ToolCallContent,
  ]
  assert.equal(toolContent(content, 'done'), undefined)
  assert.deepEqual(toolMedia(content, 'done'), [])
})

test('reads the MCP envelope a host harness passes as raw output', () => {
  const rawOutput = {
    content: [
      { type: 'text', text: 'red.png' },
      { type: 'image', data: PICTURE, mimeType: 'image/png' },
    ],
  }
  assert.deepEqual(toolMedia(undefined, rawOutput), [{ mimeType: 'image/png', data: PICTURE }])
  assert.deepEqual(toolContent(undefined, rawOutput, [{ id: 'm-1' }]), [
    { type: 'text', text: 'red.png' },
    { type: 'image', mimeType: 'image/png', byteSize: 4, mediaId: 'm-1' },
  ])
})

test('reads the update’s own content before its raw output', () => {
  const rawOutput = { content: [{ type: 'image', data: SOUND, mimeType: 'image/gif' }] }
  const content = [wrapped({ type: 'image', data: PICTURE, mimeType: 'image/png' })]
  assert.deepEqual(toolMedia(content, rawOutput), [{ mimeType: 'image/png', data: PICTURE }])
})
