// The window-name table is data and needs no test. The suffix rule beside it
// does: `seven_day_overage_included` is the window a subscription account
// actually reports, it is not in the table and never could be for every model
// variant, and looked up whole it put the raw key in front of the reader.

import assert from 'node:assert/strict'
import test from 'node:test'

import { windowLabel } from './context-ring'

test('a window reported with extra usage included is named by the window it varies', () => {
  assert.equal(windowLabel('seven_day_overage_included'), 'Weekly limit + extra usage')
  // The suffix carries its own reading onto a per-model window too, which is
  // the whole point of stripping it rather than adding a row to the table.
  assert.equal(windowLabel('seven_day_opus_overage_included'), 'Opus weekly limit + extra usage')
})

test('a window the table does not know still reads as the harness spelled it', () => {
  assert.equal(windowLabel('five_hour'), '5-hour limit')
  assert.equal(windowLabel('thirty_day'), 'thirty_day')
  // Unknown base, known suffix: the half that can be said is said.
  assert.equal(windowLabel('thirty_day_overage_included'), 'thirty_day + extra usage')
})
