// Reading a permission request into what a host decides on.
//
// The failure these exist for is silent in a way the rest of the flow is not: a
// field read from the wrong place still produces a well-formed context, the
// request is still answered, and the host's policy simply never sees the tool it
// was about to decide on — which looks exactly like the policy not being wired
// up at all.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

import { permissionContext } from './permission-context'

function request(toolCall: Partial<RequestPermissionRequest['toolCall']>): RequestPermissionRequest {
  return { sessionId: 'session-1', toolCall: { toolCallId: 'call-1', ...toolCall }, options: [] }
}

test("a request for one of the host's own tools carries that tool's name as well as its title", () => {
  const context = permissionContext(request({ title: 'mcp__local__find_nodes' }), 'local')
  assert.equal(context.localToolName, 'find_nodes')
  // The title is still what it was: it is what a person is shown, and nothing
  // here rewrites it.
  assert.equal(context.toolName, 'mcp__local__find_nodes')
  assert.equal(context.sessionId, 'session-1')
})

test('the programmatic name wins over the title', () => {
  // Both fields can name a tool and they are not required to agree. Reading the
  // display label in preference to the identity is the mix-up that classifies a
  // call by the wrong tool's declaration.
  const context = permissionContext(
    request({ name: 'mcp__local__get_nodes', title: 'mcp__local__find_nodes' }),
    'local',
  )
  assert.equal(context.localToolName, 'get_nodes')
})

test("a tool that is not the host's leaves no name behind, and its kind is passed on", () => {
  const context = permissionContext(request({ title: 'mcp__elsewhere__find_nodes', kind: 'read' }), 'local')
  assert.equal(context.localToolName, undefined)
  assert.equal(context.toolKind, 'read')
})

test('a request with no title and no kind yields neither', () => {
  // Both fields are optional in the protocol, and `null` is a value an agent may
  // actually send. Either arriving as a string would make the host decide about
  // a tool called "null".
  const context = permissionContext(request({ title: null, kind: null }), 'local')
  assert.equal(context.toolName, '')
  assert.equal(context.localToolName, undefined)
  assert.equal(context.toolKind, undefined)
})
