import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RANDOM, randomValueMode, startingPassword, startingRandom } from './secret-recipe-shared'

// ── randomValueMode ──────────────────────────────────────────────────────

test('a row not saved yet gets a random value by creating it', () => {
  assert.equal(randomValueMode({}), 'create')
  assert.equal(randomValueMode({ rotatable: true }), 'create')
})

test('a stored random or Bearer secret gets a random value by Rotate', () => {
  assert.equal(randomValueMode({ savedKey: 'TOKEN', rotatable: true }), 'rotate')
})

test('a stored typed value or password gets a random value by replacing it', () => {
  assert.equal(randomValueMode({ savedKey: 'API_KEY', rotatable: false }), 'replace')
  assert.equal(randomValueMode({ savedKey: 'API_KEY' }), 'replace')
})

// ── startingRandom ───────────────────────────────────────────────────────

test('the Random value dialog starts with a random secret’s length and format, Bearer cleared', () => {
  assert.deepEqual(startingRandom({ kind: 'random', length: 64, format: 'symbols' }), {
    spec: { length: 64, format: 'symbols' },
    bearer: false,
  })
})

test('the Random value dialog starts with a Bearer secret’s token length and format, Bearer ticked', () => {
  assert.deepEqual(startingRandom({ kind: 'bearer', token: { length: 40, format: 'hex' } }), {
    spec: { length: 40, format: 'hex' },
    bearer: true,
  })
})

test('the Random value dialog starts with the defaults for a new row and a secret stored without a recipe', () => {
  assert.deepEqual(startingRandom(undefined), { spec: DEFAULT_RANDOM, bearer: false })
  assert.deepEqual(startingRandom(null), { spec: DEFAULT_RANDOM, bearer: false })
})

// ── startingPassword ─────────────────────────────────────────────────────

test('Set password starts with a Basic secret’s login and the Basic box ticked', () => {
  assert.deepEqual(startingPassword({ kind: 'basic', login: 'alice' }), { login: 'alice', basic: true })
})

test('Set password starts with a login:password secret’s login and the Basic box cleared', () => {
  assert.deepEqual(startingPassword({ kind: 'login', login: 'bob' }), { login: 'bob', basic: false })
})

test('Set password starts with an empty login and the Basic box ticked for anything else', () => {
  for (const recipe of [undefined, null, { kind: 'typed' } as const, { kind: 'random', ...DEFAULT_RANDOM } as const]) {
    assert.deepEqual(startingPassword(recipe), { login: '', basic: true })
  }
})
