// The move's error stays on an agent only while it still needs a terminal.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { holdsStalePlacementError } from './placement-migration'

const moveError = { source: 'agent-placement', title: 'Container placement is gone: no Application found' }

test('an agent given a terminal after the move left it holds a stale move error', () => {
  assert.equal(holdsStalePlacementError({ adapterId: 'claude', terminal: 'box/terminal', __errors: [moveError] }), true)
})

test('an agent still without a terminal keeps the error', () => {
  assert.equal(holdsStalePlacementError({ adapterId: 'claude', containerName: 'gone', __errors: [moveError] }), false)
})

test('another source of error is not the move error', () => {
  assert.equal(
    holdsStalePlacementError({ terminal: 'box/terminal', __errors: [{ source: 'path', title: 'taken' }] }),
    false,
  )
})

test('an agent on the in-process harness needs no terminal, so the error is stale', () => {
  assert.equal(holdsStalePlacementError({ adapterId: 'native', __errors: [moveError] }), true)
})
