// Exercises the real database (embedded PGlite by default) and the real builtin/core
// extension bundle — see @opencroft/db's test-env for how this stays off the shared
// dev/production database regardless of the ambient environment.
//
// The point of this file: dispatchExecutionContext must work when called from code
// with NO TanStack Start request context at all — that's the situation a background
// scheduler tick is in. Deliberately does NOT wrap anything in a request/middleware
// context, unlike how these functions are normally reached in production (an HTTP
// request, or a client-triggered server function call).
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { dispatchExecutionContext } from './exec-dispatch'

async function freshSpaceWithEventAndScript(slug: string) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const eventId = 'event-1'
  const scriptId = 'script-1'
  return registry.create(slug, slug, {
    nodes: [
      { id: eventId, type: 'event', position: { x: 0, y: 0 }, data: {} },
      {
        id: scriptId,
        type: 'script',
        position: { x: 200, y: 0 },
        data: {
          language: 'node',
          script: 'function handler(event) { return { status: 200, body: { ok: true, type: event && event.type } }; }',
        },
      },
    ],
    edges: [{ id: 'edge-1', source: eventId, target: scriptId, sourceHandle: 'exec-out', targetHandle: 'exec-in' }],
  })
}

test('dispatchExecutionContext fires a connected script node with no Start context at all', async () => {
  const slug = `exec-dispatch-no-context-${crypto.randomUUID()}`
  await freshSpaceWithEventAndScript(slug)

  const summary = await dispatchExecutionContext({
    sourceNodeId: 'event-1',
    sourceHandleId: 'exec-out',
    event: { type: 'event', nodeId: 'event-1', firedAt: Date.now(), payload: {} },
  })

  assert.equal(summary.primary.error, undefined, `expected no error, got: ${summary.primary.error}`)
  assert.equal(summary.primary.status, 200)
  assert.deepEqual(summary.primary.body, { ok: true, type: 'event' })
})
