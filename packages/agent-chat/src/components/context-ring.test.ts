// The window-name table is data and needs no test. The suffix rule beside it
// does: `seven_day_overage_included` is the window a subscription account
// actually reports, it is not in the table and never could be for every model
// variant, and looked up whole it put the raw key in front of the reader.

import assert from 'node:assert/strict'
import test from 'node:test'

import { limitState, windowLabel } from './context-ring'

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

// A limit bar is coloured like the ring: by the drawn percentage against the
// same thresholds. Claude Code's `allowed_warning` is a pace verdict that
// arrives on a bar a quarter full, so it must not turn the bar amber.
test('a limit bar takes its state from the rounded percentage, not the harness warning', () => {
  const at = (utilization: number, status = 'allowed_warning') =>
    limitState({ status, window: 'seven_day', utilization }, 70, 90)
  assert.equal(at(26), 'default')
  assert.equal(at(26, 'allowed'), 'default')
  // Rounded first, as the ring is: 69.6 is drawn as 70 and coloured as 70.
  assert.equal(at(69.4), 'default')
  assert.equal(at(69.6), 'warning')
  assert.equal(at(89.6), 'danger')
})

test('a rejected window is danger at any percentage, and with none', () => {
  assert.equal(limitState({ status: 'rejected', window: 'seven_day', utilization: 12 }, 70, 90), 'danger')
  assert.equal(limitState({ status: 'rejected', window: 'five_hour' }, 70, 90), 'danger')
  assert.equal(limitState({ status: 'allowed_warning', window: 'five_hour' }, 70, 90), 'default')
})
