import assert from 'node:assert/strict'
import test from 'node:test'

import { devicePixelsAgree } from './device-pixels'

test('a device-pixel box that is the CSS box times the ratio agrees', () => {
  assert.equal(devicePixelsAgree(378, 378, 1), true)
  assert.equal(devicePixelsAgree(378, 756, 2), true)
  assert.equal(devicePixelsAgree(378, 1134, 3), true)
})

test('a fractional ratio agrees within the pixel each edge can snap by', () => {
  // 378 × 1.5 = 567 and 378 × 2.25 = 850.5: the browser rounds the box to whole device pixels.
  assert.equal(devicePixelsAgree(378, 567, 1.5), true)
  assert.equal(devicePixelsAgree(378, 851, 2.25), true)
  assert.equal(devicePixelsAgree(378, 849, 2.25), true)
})

test('a device-pixel box at the CSS size under a ratio of 2 does not agree', () => {
  // What headless Chromium reports under Playwright's deviceScaleFactor emulation.
  assert.equal(devicePixelsAgree(378, 378, 2), false)
  assert.equal(devicePixelsAgree(378, 378, 1.5), false)
})

test('a device-pixel box twice the CSS size under a ratio of 1 does not agree', () => {
  assert.equal(devicePixelsAgree(378, 756, 1), false)
})

test('with nothing to compare, the measures count as agreeing', () => {
  assert.equal(devicePixelsAgree(378, undefined, 2), true, 'no device-pixel box in this browser')
  assert.equal(devicePixelsAgree(0, 0, 2), true, 'a box with no width')
})
