import assert from 'node:assert/strict'
import test from 'node:test'

import { flattenToolResult, toCallToolResult } from './tool-result'

const PICTURE = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo'.repeat(1000) }

test('a text answer names the pictures and sounds it held, without their bytes', () => {
  const SOUND = { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg'.repeat(1000) }
  const text = flattenToolResult({ content: [{ type: 'text', text: 'shot.png: PNG, 1×1' }, PICTURE, SOUND] })
  assert.equal(
    text,
    'shot.png: PNG, 1×1\n[image image/png, not shown to the model]\n[audio audio/wav, not shown to the model]',
  )
  assert.ok(!text.includes(PICTURE.data.slice(0, 32)))
  assert.ok(!text.includes(SOUND.data.slice(0, 32)))
})

test('a block that is neither text nor media still reads as its JSON', () => {
  const block = { type: 'resource_link', uri: 'file:///x' }
  assert.equal(flattenToolResult({ content: [block] }), JSON.stringify(block))
})

test('an envelope with an image passes to the MCP surface as it is', () => {
  const envelope = { content: [PICTURE] }
  assert.equal(toCallToolResult(envelope), envelope)
})
