import assert from 'node:assert/strict'
import test from 'node:test'

import type { SecretRecipe } from '@opencroft/server/secrets'

import { type MadeSecret, makeTyped } from './secret-recipes'
import { requireSecretName, rotateSecretChecked, setSecretChecked } from './secret-writes'

const random = (length: number, charset: string) => charset[0].repeat(length)

/** Records each write; `recipes` is what the store holds, by key. */
function fakeStore(recipes: Record<string, SecretRecipe | null>) {
  const sets: Array<[string, MadeSecret]> = []
  return {
    sets,
    set: async (key: string, made: MadeSecret) => {
      sets.push([key, made])
    },
    rotateStore: {
      listRecipes: async () => new Map(Object.entries(recipes)),
      write: async (key: string, made: MadeSecret) => {
        sets.push([key, made])
      },
    },
  }
}

// ── requireSecretName ────────────────────────────────────────────────────

test('requireSecretName trims a new name', () => {
  assert.equal(requireSecretName('  API_KEY \n'), 'API_KEY')
})

test('requireSecretName refuses an empty or whitespace-only name', () => {
  assert.throws(() => requireSecretName(''), /Secret name is required/)
  assert.throws(() => requireSecretName(' \t\n'), /Secret name is required/)
})

// ── setSecretChecked ─────────────────────────────────────────────────────

test('setSecretChecked refuses a blank name and writes nothing', async () => {
  const store = fakeStore({})
  await assert.rejects(setSecretChecked('   ', makeTyped('typed-value'), store.set), /Secret name is required/)
  assert.deepEqual(store.sets, [])
})

test('setSecretChecked stores the value under the trimmed name', async () => {
  const store = fakeStore({})
  await setSecretChecked(' API_KEY ', makeTyped('typed-value'), store.set)
  assert.deepEqual(store.sets, [['API_KEY', { value: 'typed-value', recipe: { kind: 'typed' } }]])
})

// ── rotateSecretChecked ──────────────────────────────────────────────────

test('rotateSecretChecked writes the next value by the stored recipe under the exact stored key', async () => {
  const store = fakeStore({ API_KEY: { kind: 'random', length: 64, format: 'hex' } })
  assert.deepEqual(await rotateSecretChecked('API_KEY', store.rotateStore, random), {
    name: 'API_KEY',
    status: 'rotated',
  })
  assert.deepEqual(store.sets, [
    ['API_KEY', { value: '0'.repeat(64), recipe: { kind: 'random', length: 64, format: 'hex' } }],
  ])
})

test('rotateSecretChecked makes the new value by the choice when one is given', async () => {
  const store = fakeStore({ API_KEY: { kind: 'random', length: 32, format: 'alphanumeric' } })
  await rotateSecretChecked('API_KEY', store.rotateStore, random, { spec: { length: 16, format: 'hex' }, bearer: true })
  assert.deepEqual(store.sets, [
    [
      'API_KEY',
      { value: `Bearer ${'0'.repeat(16)}`, recipe: { kind: 'bearer', token: { length: 16, format: 'hex' } } },
    ],
  ])
})

test('rotateSecretChecked keeps the spaces of a padded stored key rather than creating a trimmed one', async () => {
  const store = fakeStore({ ' API_KEY ': null })
  await rotateSecretChecked(' API_KEY ', store.rotateStore, random)
  assert.deepEqual(
    store.sets.map(([key]) => key),
    [' API_KEY '],
  )
})

test('rotateSecretChecked refuses a name the store does not hold and writes nothing', async () => {
  const store = fakeStore({ ' API_KEY ': null })
  await assert.rejects(rotateSecretChecked('API_KEY', store.rotateStore, random), /"API_KEY" is not in this store/)
  assert.deepEqual(store.sets, [])
})

test('rotateSecretChecked refuses a typed value and writes nothing', async () => {
  const store = fakeStore({ API_KEY: { kind: 'typed' } })
  await assert.rejects(rotateSecretChecked('API_KEY', store.rotateStore, random), /set a new value instead/)
  assert.deepEqual(store.sets, [])
})
