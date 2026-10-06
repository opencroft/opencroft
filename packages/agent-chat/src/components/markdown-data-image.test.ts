// A `data:` picture's size, read from its header: each format's own place for
// it, and no size at all where the header does not say.

import assert from 'node:assert/strict'
import test from 'node:test'

import { DATA_IMAGE_MAX_BYTES, isDataImage, readDataImage } from './markdown-data-image'

const ascii = (text: string) => Buffer.from(text, 'latin1')
const u16be = (value: number) => Buffer.from([value >> 8, value & 0xff])
const u16le = (value: number) => Buffer.from([value & 0xff, value >> 8])
const u24le = (value: number) => Buffer.from([value & 0xff, (value >> 8) & 0xff, value >> 16])
const u32be = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const u32le = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`
const sizeOf = (mime: string, bytes: Buffer) => readDataImage(dataUrl(mime, bytes))?.size ?? null

const png = (width: number, height: number) =>
  Buffer.concat([
    ascii('\x89PNG\r\n\x1a\n'),
    u32be(13),
    ascii('IHDR'),
    u32be(width),
    u32be(height),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4),
  ])

const gif = (width: number, height: number) =>
  Buffer.concat([ascii('GIF89a'), u16le(width), u16le(height), Buffer.from([0, 0, 0])])

const jpegSegment = (marker: number, body: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(body.length + 2), body])

const jpegFrame = (marker: number, width: number, height: number) =>
  jpegSegment(marker, Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0])]))

// An APP1 block holding one directory with one entry: the orientation.
function exifOrientation(orientation: number, order: 'II' | 'MM'): Buffer {
  const u16 = order === 'II' ? u16le : u16be
  const u32 = order === 'II' ? u32le : u32be
  const tiff = Buffer.concat([
    ascii(order),
    u16(42),
    u32(8),
    u16(1),
    u16(0x0112),
    u16(3),
    u32(1),
    u16(orientation),
    u16(0),
    u32(0),
  ])
  return jpegSegment(0xe1, Buffer.concat([ascii('Exif\0\0'), tiff]))
}

const jfif = jpegSegment(0xe0, Buffer.concat([ascii('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]))
const jpeg = (...segments: Buffer[]) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xd9])])

const riff = (chunk: string, body: Buffer) =>
  Buffer.concat([ascii('RIFF'), u32le(body.length + 12), ascii('WEBP'), ascii(chunk), u32le(body.length), body])

const webpLossy = (width: number, height: number) =>
  riff('VP8 ', Buffer.concat([Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]), u16le(width), u16le(height)]))

const webpLossless = (width: number, height: number) =>
  riff('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le((width - 1) | ((height - 1) << 14)), Buffer.alloc(4)]))

const webpExtended = (width: number, height: number) =>
  riff('VP8X', Buffer.concat([Buffer.alloc(4), u24le(width - 1), u24le(height - 1)]))

test('a PNG is sized from its IHDR chunk', () => {
  assert.deepEqual(sizeOf('image/png', png(640, 480)), { width: 640, height: 480 })
})

test('a GIF is sized from its logical screen', () => {
  assert.deepEqual(sizeOf('image/gif', gif(320, 200)), { width: 320, height: 200 })
})

test('a JPEG is sized from its start-of-frame, past the segments before it', () => {
  assert.deepEqual(sizeOf('image/jpeg', jpeg(jfif, jpegFrame(0xc0, 400, 300))), { width: 400, height: 300 })
  // Progressive frames carry the size in the same place.
  assert.deepEqual(sizeOf('image/jpeg', jpeg(jfif, jpegFrame(0xc2, 400, 300))), { width: 400, height: 300 })
})

test('a JPEG turned a quarter by its EXIF orientation is sized as it is drawn', () => {
  for (const order of ['II', 'MM'] as const) {
    assert.deepEqual(
      sizeOf('image/jpeg', jpeg(exifOrientation(6, order), jpegFrame(0xc0, 400, 300))),
      { width: 300, height: 400 },
      `orientation 6, ${order}`,
    )
    assert.deepEqual(
      sizeOf('image/jpeg', jpeg(exifOrientation(3, order), jpegFrame(0xc0, 400, 300))),
      { width: 400, height: 300 },
      `orientation 3, ${order}`,
    )
  }
})

test('a WebP is sized from whichever of its three encodings it carries', () => {
  assert.deepEqual(sizeOf('image/webp', webpLossy(500, 250)), { width: 500, height: 250 })
  assert.deepEqual(sizeOf('image/webp', webpLossless(12345, 6789)), { width: 12345, height: 6789 })
  assert.deepEqual(sizeOf('image/webp', webpExtended(4000, 3000)), { width: 4000, height: 3000 })
})

test('a header cut short or not a picture at all gives no size', () => {
  assert.equal(sizeOf('image/png', png(640, 480).subarray(0, 20)), null)
  assert.equal(sizeOf('image/gif', gif(320, 200).subarray(0, 8)), null)
  assert.equal(sizeOf('image/jpeg', jpeg(jfif).subarray(0, 12)), null)
  assert.equal(sizeOf('image/webp', webpLossy(500, 250).subarray(0, 26)), null)
  assert.equal(sizeOf('image/webp', webpLossless(500, 250).subarray(0, 24)), null)
  assert.equal(sizeOf('image/webp', webpExtended(500, 250).subarray(0, 29)), null)
  assert.equal(sizeOf('image/png', ascii('this is not a picture, only some text')), null)
  // Image data begins before any frame said how large it is.
  assert.equal(sizeOf('image/jpeg', jpeg(jfif, jpegSegment(0xda, Buffer.alloc(8)), jpegFrame(0xc0, 400, 300))), null)
  // A header claiming nothing is no size either.
  assert.equal(sizeOf('image/png', png(0, 480)), null)
})

test('a payload that is not valid base64 gives no size rather than throwing', () => {
  assert.deepEqual(readDataImage('data:image/png;base64,A'), { bytes: 0, size: null })
})

test('only base64 PNG, JPEG, GIF and WebP pass', () => {
  const header = png(1, 1).toString('base64')
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.equal(isDataImage(`data:${mime};base64,${header}`), true, mime)
  }
  for (const url of [
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    `data:text/html;base64,${Buffer.from('<p>hi</p>').toString('base64')}`,
    `data:image/png,${header}`,
    `data:image/PNG;base64,${header}`,
    `data:image/png;base64,${header} onerror=alert(1)`,
    `https://example.com/picture.png`,
  ]) {
    assert.equal(isDataImage(url), false, url)
    assert.equal(readDataImage(url), null, url)
  }
})

test('a picture over the limit is measured but not read', () => {
  const header = png(640, 480).toString('base64')
  const fill = 'A'.repeat(4 * Math.ceil(DATA_IMAGE_MAX_BYTES / 3) - header.length + 4)
  const over = readDataImage(`data:image/png;base64,${header}${fill}`)
  assert.ok(over && over.bytes > DATA_IMAGE_MAX_BYTES, 'over the limit')
  assert.equal(over.size, null)

  const under = readDataImage(`data:image/png;base64,${header}${'A'.repeat(1000)}`)
  assert.deepEqual(under?.size, { width: 640, height: 480 })
})
