import assert from 'node:assert/strict'
import test from 'node:test'

import { formatCompactNumber } from './compact-number'

test('a count below a thousand is shown whole', () => {
  assert.equal(formatCompactNumber(0), '0')
  assert.equal(formatCompactNumber(950), '950')
  assert.equal(formatCompactNumber(999.4), '999')
})

test('each unit takes over at its boundary instead of the one below it growing', () => {
  assert.equal(formatCompactNumber(999_000), '999k')
  assert.equal(formatCompactNumber(1_000_000), '1M')
  assert.equal(formatCompactNumber(999_000_000), '999M')
  assert.equal(formatCompactNumber(1_000_000_000), '1B')
  assert.equal(formatCompactNumber(3_003_000_000), '3B')
  assert.equal(formatCompactNumber(1_000_000_000_000), '1T')
  assert.equal(formatCompactNumber(4_200_000_000_000), '4.2T')
})

test('a figure that rounds to 1000 of its unit reads as 1 of the next one', () => {
  assert.equal(formatCompactNumber(999.4), '999')
  assert.equal(formatCompactNumber(999.5), '1k')
  assert.equal(formatCompactNumber(999_499), '999k')
  assert.equal(formatCompactNumber(999_500), '1M')
  assert.equal(formatCompactNumber(999_999), '1M')
  assert.equal(formatCompactNumber(999_999_999), '1B')
  assert.equal(formatCompactNumber(999_950_000_000), '1T')
})

test('trillions are the last unit: past a thousand of them they stay in T', () => {
  assert.equal(formatCompactNumber(1_250_000_000_000_000), '1250T')
})

test('one decimal while small in its unit, none once it is noise', () => {
  assert.equal(formatCompactNumber(12_400), '12.4k')
  assert.equal(formatCompactNumber(680_000), '680k')
  assert.equal(formatCompactNumber(1_250_000), '1.3M')
  assert.equal(formatCompactNumber(15_400_000), '15M')
  assert.equal(formatCompactNumber(3_060_000_000), '3.1B')
})

test('a negative count reads as zero', () => {
  assert.equal(formatCompactNumber(-5), '0')
})
