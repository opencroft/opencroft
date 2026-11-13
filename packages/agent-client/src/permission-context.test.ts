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

test('the arguments the call was made with reach the host, and their absence stays absent', () => {
  // A host that dispatches many operations through one tool can only classify
  // the call by what it was asked to do; losing the input here would make every
  // such call look alike to the host's policy.
  const input = { app: 'my-space.my-graph', action: 'listNodes' }
  assert.deepEqual(
    permissionContext(request({ title: 'mcp__local__app_call', rawInput: input }), 'local').toolInput,
    input,
  )
  assert.equal(permissionContext(request({ title: 'mcp__local__app_call' }), 'local').toolInput, undefined)
  assert.equal(
    permissionContext(request({ title: 'mcp__local__app_call', rawInput: null }), 'local').toolInput,
    undefined,
  )
})

test('a request naming only the bare tool is identified by the call it updates, as it was announced', () => {
  // Copilot CLI 1.0.95: the request's title is `app_call`, while the tool call
  // announced under the same id is `local-app_call`.
  const bare = request({ title: 'app_call', kind: 'other' })
  const announced = { title: 'local-app_call' }
  assert.equal(permissionContext(bare, 'local', { announced, naming: 'server-dash-tool' }).localToolName, 'app_call')
  // Without the announcement, the bare name alone stays unidentified.
  assert.equal(permissionContext(bare, 'local', { naming: 'server-dash-tool' }).localToolName, undefined)
  // And an announcement through another server is not ours either.
  assert.equal(
    permissionContext(bare, 'local', { announced: { title: 'elsewhere-app_call' }, naming: 'server-dash-tool' })
      .localToolName,
    undefined,
  )
  // The person still sees the request's own title.
  assert.equal(permissionContext(bare, 'local', { announced, naming: 'server-dash-tool' }).toolName, 'app_call')
})

test('with dash naming, a title that reads as a read-only tool of ours identifies nothing', () => {
  // A shell command's or an edit's title is free text, and `local-get_nodes`
  // spells a read-only host tool. Read as a reference, it would let the call
  // run with no card.
  const shell = request({ title: 'local-get_nodes', kind: 'execute' })
  assert.equal(
    permissionContext(shell, 'local', { announced: { title: 'local-get_nodes' }, naming: 'server-dash-tool' })
      .localToolName,
    undefined,
  )
  assert.equal(permissionContext(shell, 'local', { naming: 'server-dash-tool' }).localToolName, undefined)
  // The announced call names a tool of ours, but not the one the request is
  // about.
  assert.equal(
    permissionContext(request({ title: 'app_call' }), 'local', {
      announced: { title: 'local-get_nodes' },
      naming: 'server-dash-tool',
    }).localToolName,
    undefined,
  )
})

test("the request's own reference wins over the announced call's", () => {
  const context = permissionContext(request({ title: 'mcp__local__get_nodes' }), 'local', {
    announced: { title: 'mcp__local__find_nodes' },
  })
  assert.equal(context.localToolName, 'get_nodes')
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
