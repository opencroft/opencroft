// The inspector's tab is remembered per node type: a button's request and the
// tab strip's pick write the same field for the node's type, so the later of
// the two is what any node of that type opens on. The instance a button chose
// stays the node's own.

import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectorIntent, inspectorTabs, registerNodeTypes } from './inspector-intent'

const TYPES: Record<string, string> = {
  'app-1': 'acme.docker.application',
  'app-2': 'acme.docker.application',
  'app-3': 'acme.docker.application',
  'agent-1': 'acme.core.agent',
  'agent-2': 'acme.core.agent',
}
registerNodeTypes((nodeId) => TYPES[nodeId])

test('a pick in the tab strip outlives the button press that opened the tab', () => {
  inspectorIntent.open('app-1', 'terminal', 'container-a')
  assert.equal(inspectorIntent.get('app-1').tab, 'terminal')

  inspectorIntent.setTab('app-1', 'details')
  assert.equal(inspectorIntent.get('app-1').tab, 'details')
  // The instance the button chose is still the one the tabs connect to.
  assert.equal(inspectorIntent.get('app-1').instanceId, 'container-a')
})

test('a tab picked on one node is the tab of every node of its type, and of no other type', () => {
  inspectorIntent.setTab('agent-1', 'profile')
  inspectorIntent.setTab('app-1', 'logs')
  assert.equal(inspectorIntent.get('app-2').tab, 'logs')

  inspectorIntent.setTab('agent-2', 'tts')
  assert.equal(inspectorIntent.get('agent-1').tab, 'tts')
  assert.equal(inspectorIntent.get('app-1').tab, 'logs')
  assert.equal(inspectorTabs.get('acme.core.agent'), 'tts')
})

test('a tab opened by a button becomes its type tab, and the instance stays with the node that asked', () => {
  inspectorIntent.open('app-2', 'terminal', 'container-b')
  assert.equal(inspectorIntent.get('app-3').tab, 'terminal')
  assert.equal(inspectorIntent.get('app-2').instanceId, 'container-b')
  assert.equal(inspectorIntent.get('app-3').instanceId, undefined)
})

test('a pick through the inspector, which names the type, reaches the nodes of that type', () => {
  inspectorTabs.set('acme.docker.application', 'volumes')
  assert.equal(inspectorIntent.get('app-1').tab, 'volumes')
})

test('a snapshot keeps its identity until its node or its type changes', () => {
  inspectorIntent.setTab('app-1', 'deploy')
  const before = inspectorIntent.get('app-1')
  inspectorIntent.setTab('agent-1', 'mcp')
  assert.equal(inspectorIntent.get('app-1'), before)
  inspectorIntent.setTab('app-2', 'logs')
  assert.notEqual(inspectorIntent.get('app-1'), before)
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
