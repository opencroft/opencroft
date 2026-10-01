// A picture written into markdown takes a fixed-height box in the markup, which
// is what a browser lays out before the picture's bytes arrive. Markdown carries
// no size, so this box is the only thing standing between a late picture and
// every line under it moving.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Markdown } from './markdown'

test('a picture in markdown takes a fixed-height box before it loads', () => {
  const html = renderToStaticMarkup(<Markdown text={'Here it is:\n\n![a chart](https://example.com/chart.png)'} />)
  const tag = html.match(/<img [^>]*>/g)
  assert.equal(tag?.length, 1, 'one picture written, one picture drawn')
  assert.match(tag[0], /src="https:\/\/example.com\/chart.png"/)
  assert.match(tag[0], /alt="a chart"/)
  assert.match(tag[0], /class="[^"]*\bh-64\b[^"]*"/)
  // Fitted inside the box and never enlarged, so a small badge stays small.
  assert.match(tag[0], /class="[^"]*\bobject-scale-down\b[^"]*"/)
})
