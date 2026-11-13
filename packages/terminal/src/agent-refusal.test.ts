import assert from 'node:assert/strict'
import test from 'node:test'

import { agentRefusalOf } from './agent-refusal'

test('agentRefusalOf answers the reason a context carries', () => {
  const reason = "Not opened: container web-1 is not this Application's."
  assert.equal(agentRefusalOf({ type: 'docker-exec', containerId: 'web-1', agentRefusal: reason }), reason)
})

test('agentRefusalOf answers null for a context that carries no reason', () => {
  assert.equal(agentRefusalOf({ type: 'docker-exec', containerId: 'web-1' }), null)
  for (const agentRefusal of ['', '   ', 42, true, null, { message: 'x' }]) {
    assert.equal(agentRefusalOf({ type: 'local', agentRefusal }), null, `ignores ${JSON.stringify(agentRefusal)}`)
  }
})

test('agentRefusalOf reads only the top level, not a wrapped context', () => {
  const inner = { type: 'local', agentRefusal: 'refused' }
  assert.equal(agentRefusalOf({ type: 'docker-exec', containerId: 'web-1', via: inner }), null)
})
