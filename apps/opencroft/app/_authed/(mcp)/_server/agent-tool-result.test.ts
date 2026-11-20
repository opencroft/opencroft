// Which handler bodies are a content list, how a picture in one is fitted for a
// model, and every way one is refused. How a body that is not one is answered
// (string as text, object as JSON) is pinned end to end in
// agent-tool-result-call.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'

import sharp from 'sharp'

import { VISION_MAX_EDGE } from '@/app/_authed/(agent)/_lib/vision-image'
import { contentListResult } from './agent-tool-result'

// A 1×1 PNG, and the first bytes of a JPEG: real signatures, so the check on
// the bytes is the one a handler's real output meets.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG_HEAD = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA=='

test('a content list of image and text items is answered as it is, in its order', async () => {
  const content = [
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'text', text: 'A single pixel' },
  ]
  assert.deepEqual(await contentListResult({ content }), { content })
})

test('a content list of text items only is answered as it is', async () => {
  const content = [
    { type: 'text', text: 'one' },
    { type: 'text', text: 'two' },
  ]
  assert.deepEqual(await contentListResult({ content }), { content })
})

test('an empty content list is answered as it is, with no items', async () => {
  assert.deepEqual(await contentListResult({ content: [] }), { content: [] })
})

test('a picture wider than a model looks at is scaled to the long edge, its other keys and items kept', async () => {
  const wide = await sharp({ create: { width: 3000, height: 400, channels: 3, background: '#2050c0' } })
    .png()
    .toBuffer()
  const result = await contentListResult({
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', data: wide.toString('base64'), mimeType: 'image/png', annotations: { priority: 1 } },
    ],
  })
  const [text, image] = (result?.content ?? []) as Record<string, unknown>[]
  assert.deepEqual(text, { type: 'text', text: 'before' })
  assert.equal(image?.mimeType, 'image/png')
  assert.deepEqual(image?.annotations, { priority: 1 })
  const sent = await sharp(Buffer.from(String(image?.data), 'base64')).metadata()
  assert.equal(sent.format, 'png')
  assert.equal(sent.width, VISION_MAX_EDGE)
  assert.equal(sent.height, Math.round((400 * VISION_MAX_EDGE) / 3000))
})

test('a body that is not a content list is left to the caller', async () => {
  const rows: [string, unknown][] = [
    ['a string', 'hello'],
    ['a number', 42],
    ['undefined', undefined],
    ['null', null],
    ['an object', { ok: true }],
    ['an array of items', [{ type: 'text', text: 'hi' }]],
    ['an object with a content array beside other keys', { content: [{ type: 'video' }], total: 1 }],
    ['an object whose content is not an array', { content: 'body text' }],
  ]
  for (const [name, body] of rows) {
    assert.equal(await contentListResult(body), undefined, name)
  }
})

test('a malformed content list is refused, naming the item and what is wrong with it', async () => {
  const rows: [string, unknown[], RegExp][] = [
    ['an unknown item type', [{ type: 'video', data: 'x' }], /content\[0\] has type "video"/],
    ['an item with no type', [{ text: 'hi' }], /content\[0\] has type undefined/],
    ['an item that is not an object', ['hi'], /content\[0\] is not an object/],
    ['a text item without text', [{ type: 'text', text: 3 }], /content\[0\] is a text item without a string "text"/],
    [
      'an image with a non-image mimeType',
      [{ type: 'image', data: PNG, mimeType: 'text/plain' }],
      /content\[0\] is an image with mimeType "text\/plain"/,
    ],
    [
      'an image type no model takes',
      [{ type: 'image', data: PNG, mimeType: 'image/svg+xml' }],
      /content\[0\] is an image with mimeType "image\/svg\+xml"/,
    ],
    ['an image without a mimeType', [{ type: 'image', data: PNG }], /content\[0\] is an image with mimeType undefined/],
    [
      'an image whose data is not base64',
      [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }],
      /content\[0\] is an image whose "data" is not base64/,
    ],
    [
      'an image with empty data',
      [{ type: 'image', data: '', mimeType: 'image/png' }],
      /content\[0\] is an image whose "data" is not base64/,
    ],
    [
      'an image whose bytes are another type than it says',
      [{ type: 'image', data: JPEG_HEAD, mimeType: 'image/png' }],
      /content\[0\] says image\/png, but its data is image\/jpeg/,
    ],
    [
      'an image whose bytes are no picture',
      [{ type: 'image', data: Buffer.from('hello world').toString('base64'), mimeType: 'image/png' }],
      /content\[0\] says image\/png, but its data is not an image/,
    ],
    [
      'an image that starts as a JPEG but does not decode',
      [{ type: 'image', data: JPEG_HEAD, mimeType: 'image/jpeg' }],
      /Cannot view content\[0\]: it could not be decoded as image\/jpeg/,
    ],
    [
      'a bad item after a good one',
      [
        { type: 'text', text: 'fine' },
        { type: 'resource_link', uri: 'file:///x' },
      ],
      /content\[1\] has type "resource_link"/,
    ],
  ]
  for (const [name, content, message] of rows) {
    await assert.rejects(contentListResult({ content }), message, name)
  }
})

test('every malformed item is named in one refusal', async () => {
  await assert.rejects(
    contentListResult({ content: [{ type: 'video' }, { type: 'text', text: 'ok' }, { type: 'audio' }] }),
    (err: Error) => {
      assert.match(err.message, /content\[0\] has type "video"/)
      assert.match(err.message, /content\[2\] has type "audio"/)
      assert.doesNotMatch(err.message, /content\[1\]/)
      return true
    },
  )
})
