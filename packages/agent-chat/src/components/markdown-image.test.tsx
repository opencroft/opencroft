// A picture written into markdown takes its box in the markup, which is what a
// browser lays out before the picture's bytes arrive. A remote picture carries
// no size, so it takes a fixed-height box; a `data:` picture carries its header,
// so it takes its own size.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Markdown } from './markdown'
import { DATA_IMAGE_MAX_BYTES } from './markdown-data-image'

function pictureTag(text: string): string {
  const tag = renderToStaticMarkup(<Markdown text={text} />).match(/<img [^>]*>/g)
  assert.equal(tag?.length, 1, 'one picture written, one picture drawn')
  return tag[0]
}

// A PNG's signature and IHDR chunk: all the size reading needs.
function pngUrl(width: number, height: number): string {
  const header = Buffer.alloc(33)
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return `data:image/png;base64,${header.toString('base64')}`
}

test('a picture in markdown takes a fixed-height box before it loads', () => {
  const tag = pictureTag('Here it is:\n\n![a chart](https://example.com/chart.png)')
  assert.match(tag, /src="https:\/\/example.com\/chart.png"/)
  assert.match(tag, /alt="a chart"/)
  assert.match(tag, /class="[^"]*\bh-64\b[^"]*"/)
  // Fitted inside the box and never enlarged, so a small badge stays small.
  assert.match(tag, /class="[^"]*\bobject-scale-down\b[^"]*"/)
})

test('a data: picture takes its own size before it loads', () => {
  const url = pngUrl(100, 50)
  const tag = pictureTag(`![a dot](${url})`)
  assert.ok(tag.includes(`src="${url}"`), 'the data URL is the source')
  assert.match(tag, /alt="a dot"/)
  assert.match(tag, /width="100"/)
  assert.match(tag, /height="50"/)
  assert.match(tag, /style="width:100px"/)
  // The ratio from width and height carries the height, also when a narrow
  // column shrinks the width.
  assert.match(tag, /class="[^"]*\bh-auto\b[^"]*"/)
  assert.match(tag, /class="[^"]*\bmax-w-full\b[^"]*"/)
  assert.doesNotMatch(tag, /\bh-64\b/)
})

test('a tall data: picture is narrowed to the band height, keeping its ratio', () => {
  const tag = pictureTag(`![tall](${pngUrl(300, 600)})`)
  assert.match(tag, /width="300"/)
  assert.match(tag, /height="600"/)
  assert.match(tag, /style="width:128px"/)
})

test('a data: picture whose header gives no size takes the fixed-height box', () => {
  const url = `data:image/png;base64,${Buffer.from('not a picture header').toString('base64')}`
  const tag = pictureTag(`![broken](${url})`)
  assert.ok(tag.includes(`src="${url}"`), 'still drawn from its data URL')
  assert.match(tag, /class="[^"]*\bh-64\b[^"]*"/)
  assert.doesNotMatch(tag, /width=/)
})

test('a data: picture over the limit is a note, not a picture', () => {
  const fill = 'A'.repeat(4 * Math.ceil((DATA_IMAGE_MAX_BYTES + 1) / 3))
  const html = renderToStaticMarkup(<Markdown text={`![huge](data:image/png;base64,${fill})`} />)
  assert.doesNotMatch(html, /<img /)
  assert.match(html, /Image too large to show \(8\.0 MiB, over the 8\.0 MiB limit\)/)
  assert.match(html, /title="huge"/)
})

test('an SVG or non-image data: URL never becomes a picture source', () => {
  for (const url of [
    `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
    `data:text/html;base64,${Buffer.from('<p>hi</p>').toString('base64')}`,
  ]) {
    const html = renderToStaticMarkup(<Markdown text={`![x](${url})`} />)
    assert.doesNotMatch(html, /data:/, url)
  }
})

test('a data: URL in a link is refused, a picture one included', () => {
  for (const url of [pngUrl(100, 50), `data:text/html;base64,${Buffer.from('<p>hi</p>').toString('base64')}`]) {
    const html = renderToStaticMarkup(<Markdown text={`[open](${url})`} />)
    assert.match(html, /<a [^>]*>open<\/a>/)
    assert.doesNotMatch(html, /data:/, url)
  }
})
