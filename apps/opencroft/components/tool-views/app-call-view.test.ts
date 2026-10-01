// `appActionView` is how a graph write's own view is found inside an
// app_call's `{ app, action, params }` args — by the chat transcript, which
// only ever sees 'app_call', and by the approval queue, whose server-set
// 'graph.*' view keys resolve to the same spec. It has to check the params
// shape, not just the action id, because an extension App can declare its own
// action under the same id as one of the graph's — an id match alone would let
// an unrelated call borrow the graph's view.

import assert from 'node:assert/strict'
import test from 'node:test'

import { appActionView } from 'ui/tool-views/graph-views'
import { TOOL_VIEWS } from 'ui/tool-views/tool-views'

test('app_call and the graph view keys are one spec, so both callers unwrap the same way', () => {
  for (const key of ['graph.updateNodes', 'graph.writeNodeProperty', 'graph.editNodeProperty']) {
    assert.equal(TOOL_VIEWS[key], TOOL_VIEWS.app_call, key)
  }
})

test('a graph action with matching params resolves to the graph view', () => {
  const resolved = appActionView({
    app: 'demo.build',
    action: 'updateNodes',
    params: { updates: [{ nodeId: 'node-1', data: { name: 'Renamed' } }] },
  })
  assert.ok(resolved)
  assert.equal(resolved.view.body.name, 'UpdateNodesView')
  assert.deepEqual(resolved.params, { updates: [{ nodeId: 'node-1', data: { name: 'Renamed' } }] })
})

test('the same action id with params that do not match the graph shape resolves to nothing', () => {
  // An extension App declaring its own "updateNodes" action is free to give
  // it a completely different params shape — this must not be mistaken for
  // the graph's own action just because the id happens to coincide.
  const resolved = appActionView({
    app: 'demo.inventory',
    action: 'updateNodes',
    params: { sku: 'widget-1', delta: -3 },
  })
  assert.equal(resolved, undefined)
})

test('an action the graph does not declare resolves to nothing', () => {
  const resolved = appActionView({
    app: 'demo.build',
    action: 'deploy',
    params: { environment: 'staging' },
  })
  assert.equal(resolved, undefined)
})

test('writeNodeProperty and editNodeProperty resolve the same way, and name the node they act on', () => {
  const write = appActionView({
    app: 'demo.build',
    action: 'writeNodeProperty',
    params: { nodeId: 'node-1', path: 'script', value: 'echo hi' },
  })
  assert.ok(write)
  assert.equal(write.view.body.name, 'WriteNodePropertyView')
  const writeArgs = { app: 'demo.build', action: 'writeNodeProperty', params: write.params }
  assert.equal(TOOL_VIEWS.app_call.getNodeId?.(writeArgs), 'node-1', 'View node reads the node out of params')

  const edit = appActionView({
    app: 'demo.build',
    action: 'editNodeProperty',
    params: { nodeId: 'node-1', path: 'script', oldString: 'hi', newString: 'bye' },
  })
  assert.ok(edit)
  assert.equal(edit.view.body.name, 'EditNodePropertyView')

  // writeNodeProperty's shape (nodeId + path) is a strict subset of
  // editNodeProperty's (nodeId + path + oldString + newString) — a call
  // missing fields must not satisfy editNodeProperty's matcher.
  const mismatched = appActionView({
    app: 'demo.build',
    action: 'editNodeProperty',
    params: { nodeId: 'node-1', path: 'script' },
  })
  assert.equal(mismatched, undefined)
})
