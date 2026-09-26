// Who decides whether a tool call is asked about.
//
// The defect these pin: the gate used to decide on the kind the permission
// request arrived with, and nothing guarantees that a harness classifies this
// app's tools at all — one in use classifies none of them, so every read-only
// tool prompted. The declaration is the app's own and is available on every
// request, so it answers first and the kind answers only where there is no
// declaration to consult.
//
// For `app_call` the declaration is per ACTION, read from the call's input and
// resolved on the server — graph-actions.test.ts pins that resolution against
// real apps; here it is the permission outcome built on it.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { PermissionContext } from 'agent-client/agent-client'

import { toolPermissionOutcome } from '@/app/_authed/(agent)/_server/tool-permission'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

function request(context: Partial<PermissionContext>): PermissionContext {
  return { sessionId: 'session-1', toolName: 'a tool call', ...context }
}

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const slug = `tool-permission-${crypto.randomUUID()}`
await registry.create(slug, slug, { nodes: [], edges: [] })
const graphAddress = `${slug}.${registry.graphsOf(slug)[0]?.slug}`

test('a tool this app declared read-only is allowed, with no kind in the request', async () => {
  // The measured failure: a pure read prompting because the harness sent no
  // kind for it. Nothing about the request says "read" here — the answer comes
  // from this app's own classification.
  assert.equal(await toolPermissionOutcome(request({ localToolName: 'list_spaces' })), 'allow')
})

test('a tool this app did not declare read-only prompts even when the request calls it a read', async () => {
  // The direction that matters for a gate: a kind arriving from outside cannot
  // promote a tool the app deliberately left out of the set. `db_read` is
  // excluded by name and with a reason, and a harness guessing `read` from its
  // name would otherwise wave it through.
  assert.equal(await toolPermissionOutcome(request({ localToolName: 'db_read', toolKind: 'read' })), 'prompt')
  assert.equal(await toolPermissionOutcome(request({ localToolName: 'remote_write', toolKind: 'read' })), 'prompt')
})

test('an app_call is allowed only when the input names a host App’s read-only action', async () => {
  const appCall = (toolInput: unknown) => request({ localToolName: 'app_call', toolKind: 'read', toolInput })
  assert.equal(await toolPermissionOutcome(appCall({ app: graphAddress, action: 'listNodes' })), 'allow')
  assert.equal(await toolPermissionOutcome(appCall({ app: graphAddress, action: 'updateNodes' })), 'prompt')
  // Unresolvable, malformed or absent input is a write, whatever the kind says.
  assert.equal(await toolPermissionOutcome(appCall({ app: 'nowhere.default', action: 'listNodes' })), 'prompt')
  assert.equal(await toolPermissionOutcome(appCall({ action: 'listNodes' })), 'prompt')
  assert.equal(await toolPermissionOutcome(appCall(undefined)), 'prompt')
})

test("a tool that is not this app's keeps deciding on the kind it arrived with", async () => {
  // Another MCP server's tools, and a harness's own built-ins, carry no
  // declaration here. Dropping the kind for them would restore the prompt on
  // every read they make, which is the friction this whole classification
  // exists to remove.
  assert.equal(await toolPermissionOutcome(request({ toolKind: 'read' })), 'allow')
  assert.equal(await toolPermissionOutcome(request({ toolKind: 'search' })), 'allow')
  assert.equal(await toolPermissionOutcome(request({ toolKind: 'edit' })), 'prompt')
})

test("a tool that is not this app's and carries no kind prompts", async () => {
  // Undeclared and unclassified is the case with nothing to go on, and asking
  // is the only safe answer to it.
  assert.equal(await toolPermissionOutcome(request({})), 'prompt')
})
