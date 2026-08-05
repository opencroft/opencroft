// Exercises the real database (embedded PGlite) and the real builtin/core extension
// bundle, calling handleToolCall directly rather than through the HTTP route — the
// route establishes a TanStack Start request context that the production MCP
// transport does not always have (see the -no-context.test.ts siblings in this
// extension-runtime tree). That gap is exactly what let list_actions/call silently
// return no data: their handlers ran, but a server-fn wrapper called with no Start
// context drops its return value instead of throwing.
//
// See @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { handleToolCall } from './tools'

async function freshSpaceWithSecretsStoreNode(slug: string): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const nodeId = `${slug}-node`
  await registry.create(slug, slug, {
    nodes: [{ id: nodeId, type: 'core-secrets-store', position: { x: 0, y: 0 }, data: { secretKeys: [] } }],
    edges: [],
  })
  return nodeId
}

test('list_actions returns the real action list, not an empty/undefined result', async () => {
  const nodeId = await freshSpaceWithSecretsStoreNode(`tools-it-list-${crypto.randomUUID()}`)

  const result = await handleToolCall('list_actions', { nodeId }, {})

  assert.equal(result.isError, undefined)
  const text = (result.content as { type: string; text: string }[])[0]?.text
  assert.ok(text, 'list_actions must return real text, not undefined')
  const actions = JSON.parse(text) as { actionId: string }[]
  assert.ok(
    actions.some((a) => a.actionId === 'generate'),
    'core-secrets-store exposes a "generate" action',
  )
})

// A matching test for the `call` handler (dispatchNodeActionImpl) is deliberately
// not here: that path runs the action through getExtensionModule's real compiled
// bundle eval, and this codebase's plain test runner can't cross that boundary —
// it hangs the test process rather than failing cleanly. Other tests touching this
// same extension server code note the identical limitation. list_actions above
// needs only the static manifest, which the plain runner handles fine.
