import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { RUN_OUTPUTS, runOutputValue } from './run-outputs'

const request = {
  method: 'POST',
  path: '/users/7',
  params: { id: '7' },
  query: { name: 'Ada' },
  headers: { 'content-type': 'application/json' },
  body: { user: { age: 30 } },
}

test("an API Route's outputs carry its request", () => {
  assert.deepEqual(runOutputValue('api-route', 'body', request), { user: { age: 30 } })
  assert.deepEqual(runOutputValue('api-route', 'query', request), { name: 'Ada' })
  assert.deepEqual(runOutputValue('api-route', 'params', request), { id: '7' })
  assert.deepEqual(runOutputValue('api-route', 'headers', request), { 'content-type': 'application/json' })
  assert.equal(runOutputValue('api-route', 'method', request), 'POST')
  assert.equal(runOutputValue('api-route', 'text', request), undefined)
})

test('a body that is not a JSON object gives no body; its text comes on Text', () => {
  assert.equal(runOutputValue('api-route', 'body', { ...request, body: [1, 2] }), undefined)
  assert.equal(runOutputValue('api-route', 'body', { ...request, body: 'plain', text: 'plain' }), undefined)
  assert.equal(runOutputValue('api-route', 'text', { ...request, body: 'plain', text: 'plain' }), 'plain')
})

test("an Event's and an Agent Tool's outputs carry the fire and the call", () => {
  const fire = { type: 'event', nodeId: 'e', firedAt: 1_700_000_000_000, payload: { level: 3 } }
  assert.deepEqual(runOutputValue('event', 'payload', fire), { level: 3 })
  assert.equal(runOutputValue('event', 'firedAt', fire), 1_700_000_000_000)
  assert.deepEqual(runOutputValue('agent-tool', 'args', { params: { q: 'x' }, context: { toolName: 't' } }), {
    q: 'x',
  })
})

test('outside a run, every run-time output has nothing', () => {
  for (const [type, handles] of Object.entries(RUN_OUTPUTS)) {
    for (const handle of handles) {
      assert.equal(runOutputValue(type, handle.id, undefined), undefined, `${type}/${handle.id}`)
    }
  }
})

// The server reads the handles from the manifest, the canvas from these: they must agree.
test('the manifest declares the same run-time outputs, each `runtime: true`', () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'extension.json'), 'utf-8')) as {
    nodes: Array<{ type: string; handles?: Array<Record<string, unknown>> }>
  }
  for (const [type, handles] of Object.entries(RUN_OUTPUTS)) {
    const declared = manifest.nodes.find((n) => n.type === type)?.handles?.filter((h) => h.runtime === true) ?? []
    assert.deepEqual(declared, handles, type)
  }
})
