// The instance's brand colour, read from its environment. Only a palette name
// changes the colour: an unset, blank or unknown value leaves an instance in
// the default blue, and an unknown one is reported so a typo does not pass
// silently as the default.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BRAND_COLORS, isBrandColor } from 'ui/logo'

import { resolveBrandColor } from '@/app/_server/brand-color'

test('a palette name is that colour, in any letter case and with surrounding space', () => {
  assert.deepEqual(resolveBrandColor('green'), { color: 'green' })
  assert.deepEqual(resolveBrandColor('rose'), { color: 'rose' })
  assert.deepEqual(resolveBrandColor(' Lime\n'), { color: 'lime' })
})

test('unset or blank is the default blue, and not reported', () => {
  for (const value of [undefined, '', '   ']) {
    assert.deepEqual(resolveBrandColor(value), { color: 'blue' }, `${JSON.stringify(value)} is blue`)
  }
})

test('an unknown value is the default blue, and reported as it was given', () => {
  for (const value of ['#22c55e', 'green-500', 'toString', 'grey']) {
    assert.deepEqual(resolveBrandColor(value), { color: 'blue', unknown: value }, `${value} is blue`)
  }
})

test('names an object inherits are not brand colours', () => {
  for (const value of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', null, 1, {}]) {
    assert.equal(isBrandColor(value), false, `${String(value)} is not a brand colour`)
  }
})

test('the default blue is the colour the mark was drawn in before it could change', () => {
  assert.equal(BRAND_COLORS.blue, '#3b82f6')
})
