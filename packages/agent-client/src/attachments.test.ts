import assert from 'node:assert/strict'
import test from 'node:test'

import { attachmentRefsIn, attachmentTag, isImageMime } from './attachments'

test('a tag round-trips the reference a composer wrote', () => {
  const ref = { id: 'att-1', name: 'shot.png', mimeType: 'image/png' }
  assert.deepEqual(attachmentRefsIn(attachmentTag(ref)), [ref])
})

test('tags are read in the order the message names them, amid prose', () => {
  const text = `before ${attachmentTag({ id: 'a', name: 'one.png', mimeType: 'image/png' })} between ${attachmentTag({
    id: 'b',
    name: 'two.webp',
    mimeType: 'image/webp',
  })} after`
  assert.deepEqual(
    attachmentRefsIn(text).map((ref) => ref.id),
    ['a', 'b'],
  )
})

test('a tag with no id names nothing loadable and is left as text', () => {
  assert.deepEqual(attachmentRefsIn('<user-attachment name="shot.png" type="image/png"/>'), [])
})

test('a name falls back to the id, so a chip always has something to say', () => {
  assert.deepEqual(attachmentRefsIn('<user-attachment id="att-9"/>'), [{ id: 'att-9', name: 'att-9', mimeType: '' }])
})

test('a name cannot end the tag early', () => {
  // The characters that would close the tag are dropped rather than escaped —
  // a name is a label, and an escaping scheme needs a decoder nothing here has.
  const tag = attachmentTag({ id: 'att-1', name: 'a"/><script>b', mimeType: 'image/png' })
  assert.equal(tag.includes('<script>'), false)
  assert.deepEqual(attachmentRefsIn(tag), [{ id: 'att-1', name: 'a/scriptb', mimeType: 'image/png' }])
})

test('only an image mime may travel as an image block', () => {
  assert.equal(isImageMime('image/png'), true)
  assert.equal(isImageMime('image/svg+xml'), true)
  assert.equal(isImageMime('application/pdf'), false)
  assert.equal(isImageMime(''), false)
})
