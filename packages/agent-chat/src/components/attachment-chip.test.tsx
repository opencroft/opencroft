// The chip's second line: what a picture will travel as. The resolution half
// is measured from the loaded image and so needs a browser; the size half is a
// prop, and that is what is pinned here.
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AttachmentChip, formatByteSize } from './attachment-chip'

test('a byte count reads the way a reader reads it', () => {
  assert.equal(formatByteSize(512), '512 B')
  assert.equal(formatByteSize(2048), '2.0 KB')
  assert.equal(formatByteSize(348160), '340 KB')
  assert.equal(formatByteSize(2516582), '2.4 MB')
})

test('the name is the first line and the size the second, beside the picture', () => {
  const markup = renderToStaticMarkup(
    <AttachmentChip name='shot.png' src='/shot.png' byteSize={2516582} onRemove={() => {}} />,
  )
  const name = markup.indexOf('>shot.png<')
  const size = markup.indexOf('>2.4 MB<')
  assert.notEqual(name, -1, `the name is drawn:\n${markup}`)
  assert.notEqual(size, -1, `the size is drawn:\n${markup}`)
  assert.ok(name < size, 'the size is the line under the name')
})

test('with no size known and nothing measured yet, there is no second line at all', () => {
  const markup = renderToStaticMarkup(<AttachmentChip name='shot.png' src='/shot.png' onRemove={() => {}} />)
  assert.equal(markup.includes('tabular-nums'), false, `no empty second line:\n${markup}`)
})
