import assert from 'node:assert/strict'
import test from 'node:test'

import { isImageMime } from './attachments'

test('only an image mime may travel as an image block', () => {
  assert.equal(isImageMime('image/png'), true)
  assert.equal(isImageMime('image/svg+xml'), true)
  assert.equal(isImageMime('application/pdf'), false)
  assert.equal(isImageMime(''), false)
})
