// The store is the node's inspector tab. A button's request and the tab strip's
// pick write the same field, so the later of the two is what a reselection
// shows -- the bug was a copy in the inspector that only the button reached.

import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectorIntent } from './inspector-intent'

test('a pick in the tab strip outlives the button press that opened the tab', () => {
  inspectorIntent.open('app-1', 'terminal', 'container-a')
  assert.equal(inspectorIntent.get('app-1').tab, 'terminal')

  inspectorIntent.setTab('app-1', 'details')
  assert.equal(inspectorIntent.get('app-1').tab, 'details')
  // The instance the button chose is still the one the tabs connect to.
  assert.equal(inspectorIntent.get('app-1').instanceId, 'container-a')
})

test('every open is announced with its node, and unsubscribing stops the announcements', () => {
  const opened: string[] = []
  const stop = inspectorIntent.onOpen((nodeId) => opened.push(nodeId))
  inspectorIntent.open('app-2', 'logs')
  inspectorIntent.setTab('app-2', 'details')
  inspectorIntent.open('app-2', 'logs')
  stop()
  inspectorIntent.open('app-2', 'logs')
  assert.deepEqual(opened, ['app-2', 'app-2'])
})

test('a node nobody has asked about has no tab', () => {
  assert.deepEqual(inspectorIntent.get('never-seen'), {})
})
