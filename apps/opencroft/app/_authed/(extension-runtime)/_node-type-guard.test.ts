import assert from 'node:assert/strict'
import test from 'node:test'

import { assertUniqueNodeTypeIds, manifestOwners } from './_node-type-guard'

test('no owners: passes', () => {
  assert.doesNotThrow(() => assertUniqueNodeTypeIds([]))
})

test('one extension, no type ids: passes', () => {
  assert.doesNotThrow(() => assertUniqueNodeTypeIds([{ extensionId: 'local/a', typeIds: [] }]))
})

test('distinct type ids across distinct extensions: passes', () => {
  assert.doesNotThrow(() =>
    assertUniqueNodeTypeIds([
      { extensionId: 'local/a', typeIds: ['foo', 'bar'] },
      { extensionId: 'local/b', typeIds: ['baz'] },
    ]),
  )
})

test('two extensions declaring the same type id: throws, naming the type id and both extensions', () => {
  assert.throws(
    () =>
      assertUniqueNodeTypeIds([
        { extensionId: 'local/a', typeIds: ['agent'] },
        { extensionId: 'local/b', typeIds: ['agent'] },
      ]),
    (err) => {
      const message = (err as Error).message
      assert.match(message, /"agent"/)
      assert.match(message, /local\/a/)
      assert.match(message, /local\/b/)
      return true
    },
  )
})

test('a type id repeated twice within one extension is not a collision with itself', () => {
  // A caller building the owner list from a slightly malformed manifest could
  // list the same type id twice for one extension; that must not read as two
  // extensions fighting over it.
  assert.doesNotThrow(() => assertUniqueNodeTypeIds([{ extensionId: 'local/a', typeIds: ['agent', 'agent'] }]))
})

test('multiple independent collisions are all reported in one error, not just the first', () => {
  assert.throws(
    () =>
      assertUniqueNodeTypeIds([
        { extensionId: 'local/a', typeIds: ['agent', 'send-message'] },
        { extensionId: 'local/b', typeIds: ['agent', 'send-message'] },
      ]),
    (err) => {
      const message = (err as Error).message
      assert.match(message, /"agent"/)
      assert.match(message, /"send-message"/)
      return true
    },
  )
})

test('manifestOwners flattens a manifest list into owner entries', () => {
  assert.deepEqual(
    manifestOwners([{ id: 'local/a', nodes: [{ typeId: 'foo' }, { typeId: 'bar' }] }, { id: 'local/b' }]),
    [
      { extensionId: 'local/a', typeIds: ['foo', 'bar'] },
      { extensionId: 'local/b', typeIds: [] },
    ],
  )
})

test('manifestOwners feeding straight into assertUniqueNodeTypeIds catches a real collision', () => {
  // The exact shape production manifests take (extension.json's `id` +
  // `nodes[].typeId`), fed through both functions together rather than
  // exercised in isolation.
  assert.throws(
    () =>
      assertUniqueNodeTypeIds(
        manifestOwners([
          { id: 'local/first', nodes: [{ typeId: 'send-message' }, { typeId: 'text-generation' }] },
          { id: 'local/second', nodes: [{ typeId: 'agent' }, { typeId: 'send-message' }] },
        ]),
      ),
    /"send-message"/,
  )
})

test('three-way collision names every claimant, not just two', () => {
  assert.throws(
    () =>
      assertUniqueNodeTypeIds([
        { extensionId: 'local/a', typeIds: ['agent'] },
        { extensionId: 'local/b', typeIds: ['agent'] },
        { extensionId: 'local/c', typeIds: ['agent'] },
      ]),
    (err) => {
      const message = (err as Error).message
      assert.match(message, /local\/a/)
      assert.match(message, /local\/b/)
      assert.match(message, /local\/c/)
      return true
    },
  )
})
