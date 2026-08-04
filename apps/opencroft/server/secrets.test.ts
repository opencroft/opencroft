// Exercises the real database (embedded PGlite) — no mocking, so an encrypt/decrypt
// mismatch or a broken upsert target shows up here rather than only in production.
import assert from 'node:assert/strict'
import test from 'node:test'

import { secrets } from './secrets'

// The secrets-store inspector's manual "Add Secret" rows call secrets.set()
// sequentially, once per dirty row, same as this test does. If this passes but
// the UI still loses a secret, the defect is in the extension's
// invoke()/action-registry plumbing, not in this underlying write path.
test('sequential set() calls for multiple keys on one store all land, and list() reflects all of them', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'FIRST', 'value-one')
  await secrets.set(storeId, 'SECOND', 'value-two')

  const rows = await secrets.list(storeId)
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  assert.equal(byKey.get('FIRST'), 'value-one')
  assert.equal(byKey.get('SECOND'), 'value-two')
  assert.equal(rows.length, 2)
})

test('set() on an existing key updates the value in place instead of erroring or duplicating', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'KEY', 'original')
  await secrets.set(storeId, 'KEY', 'rotated')

  const rows = await secrets.list(storeId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 'rotated')
})

test('delete() then set() on the same key recreates it, matching the row-remove-then-readd UI flow', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'KEY', 'v1')
  await secrets.delete(storeId, 'KEY')
  assert.equal(await secrets.get(storeId, 'KEY'), null)

  await secrets.set(storeId, 'KEY', 'v2')
  assert.equal(await secrets.get(storeId, 'KEY'), 'v2')
})
