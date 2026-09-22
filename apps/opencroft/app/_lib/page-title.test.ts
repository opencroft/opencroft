import assert from 'node:assert/strict'
import test from 'node:test'

import { PRODUCT_NAME, pageTitle } from '@/app/_lib/page-title'

test('names the app and the space it is open in, most specific first', () => {
  assert.equal(pageTitle('Git', 'opencroft'), `Git · opencroft · ${PRODUCT_NAME}`)
})

test('a single part still gets the product name after it', () => {
  assert.equal(pageTitle('Spaces'), `Spaces · ${PRODUCT_NAME}`)
})

test('a part nobody could name yet is dropped, not rendered as a gap', () => {
  assert.equal(pageTitle(undefined, 'opencroft'), `opencroft · ${PRODUCT_NAME}`)
  assert.equal(pageTitle('Settings', null), `Settings · ${PRODUCT_NAME}`)
  assert.equal(pageTitle('  ', 'opencroft'), `opencroft · ${PRODUCT_NAME}`)
})

test('knowing nothing at all is the product name alone, never a stray separator', () => {
  assert.equal(pageTitle(), PRODUCT_NAME)
  assert.equal(pageTitle(undefined, null, ''), PRODUCT_NAME)
})

test('a name is trimmed rather than padding the separator', () => {
  assert.equal(pageTitle(' Git ', 'opencroft'), `Git · opencroft · ${PRODUCT_NAME}`)
})
