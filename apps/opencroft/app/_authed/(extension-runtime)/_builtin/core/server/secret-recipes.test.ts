import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_RANDOM } from '../src/nodes/secret-recipe-shared'
import { canRotate, makeLoginPassword, makeRandom, makeTyped, randomChoice, randomSpec, remake } from './secret-recipes'

/** A random source that records the charset it was asked for and fills with its first character. */
function recordingRandom() {
  const calls: Array<{ length: number; charset: string }> = []
  return {
    calls,
    random: (length: number, charset: string) => {
      calls.push({ length, charset })
      return charset[0].repeat(length)
    },
  }
}

const SYMBOLS = /^[A-Za-z0-9!@#%^&*_+\-=]+$/

// ── randomSpec ───────────────────────────────────────────────────────────

test('randomSpec fills the defaults in', () => {
  assert.deepEqual(randomSpec(), DEFAULT_RANDOM)
  assert.deepEqual(randomSpec({ format: 'hex' }), { length: 32, format: 'hex' })
})

test('randomSpec refuses a length out of bounds and an unknown format', () => {
  assert.throws(() => randomSpec({ length: 7 }), /between 8 and 256/)
  assert.throws(() => randomSpec({ length: 257 }), /between 8 and 256/)
  assert.throws(() => randomSpec({ length: 12.5 }), /between 8 and 256/)
  assert.throws(() => randomSpec({ format: 'emoji' as never }), /format must be one of/)
})

// ── remake (Rotate) ──────────────────────────────────────────────────────

test('remake repeats a random recipe: 64 symbols give 64 symbols-charset characters', () => {
  const rec = recordingRandom()
  const made = remake({ kind: 'random', length: 64, format: 'symbols' }, rec.random)
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0].length, 64)
  assert.match(rec.calls[0].charset, SYMBOLS)
  assert.ok(rec.calls[0].charset.includes('!'), 'the symbols charset, not the alphanumeric one')
  assert.equal(made.value.length, 64)
  assert.deepEqual(made.recipe, { kind: 'random', length: 64, format: 'symbols' })
})

test('remake of a real random draw stays inside the format alphabet', () => {
  const random = (length: number, charset: string) =>
    Array.from({ length }, (_, i) => charset[(i * 7) % charset.length]).join('')
  assert.match(remake({ kind: 'random', length: 40, format: 'hex' }, random).value, /^[0-9a-f]{40}$/)
  assert.match(remake({ kind: 'random', length: 40, format: 'base64url' }, random).value, /^[A-Za-z0-9_-]{40}$/)
  assert.match(remake({ kind: 'random', length: 60, format: 'password' }, random).value, /^[^0O1lI]{60}$/)
})

test('remake treats a secret stored without a recipe as random with the defaults', () => {
  const rec = recordingRandom()
  const made = remake(null, rec.random)
  assert.equal(made.value.length, DEFAULT_RANDOM.length)
  assert.deepEqual(made.recipe, { kind: 'random', ...DEFAULT_RANDOM })
})

test('remake makes a new random Bearer token under the same prefix', () => {
  const rec = recordingRandom()
  const made = remake({ kind: 'bearer', token: { length: 40, format: 'base64url' } }, rec.random)
  assert.match(made.value, /^Bearer [A-Za-z0-9_-]{40}$/)
  assert.deepEqual(made.recipe, { kind: 'bearer', token: { length: 40, format: 'base64url' } })
})

test('remake with the Bearer box ticked puts a random value under the prefix', () => {
  const rec = recordingRandom()
  const made = remake({ kind: 'random', length: 48, format: 'hex' }, rec.random, {
    spec: { length: 48, format: 'hex' },
    bearer: true,
  })
  assert.equal(made.value, `Bearer ${'0'.repeat(48)}`)
  assert.deepEqual(made.recipe, { kind: 'bearer', token: { length: 48, format: 'hex' } })
})

test('remake with the Bearer box cleared drops the prefix', () => {
  const rec = recordingRandom()
  const made = remake({ kind: 'bearer', token: { length: 40, format: 'hex' } }, rec.random, {
    spec: { length: 40, format: 'hex' },
    bearer: false,
  })
  assert.equal(made.value, '0'.repeat(40))
  assert.deepEqual(made.recipe, { kind: 'random', length: 40, format: 'hex' })
})

test('remake by a changed length and format draws by them and makes them the recipe', () => {
  const rec = recordingRandom()
  const made = remake(null, rec.random, { spec: { length: 12, format: 'hex' }, bearer: true })
  assert.equal(made.value, `Bearer ${'0'.repeat(12)}`)
  assert.deepEqual(made.recipe, { kind: 'bearer', token: { length: 12, format: 'hex' } })
})

test('remake refuses a value someone brought, whatever is chosen, drawing nothing', () => {
  const rec = recordingRandom()
  const choice = { spec: DEFAULT_RANDOM, bearer: true }
  for (const recipe of [
    { kind: 'typed' } as const,
    { kind: 'basic', login: 'alice' } as const,
    { kind: 'login', login: 'alice' } as const,
  ]) {
    assert.throws(() => remake(recipe, rec.random), /set a new value instead/)
    assert.throws(() => remake(recipe, rec.random, choice), /set a new value instead/)
  }
  assert.equal(rec.calls.length, 0)
})

// ── randomChoice, makeRandom (Random value…, generate) ──────────────────

test('randomChoice checks the length and format and takes only bearer: true as the prefix', () => {
  assert.deepEqual(randomChoice(), { spec: DEFAULT_RANDOM, bearer: false })
  assert.deepEqual(randomChoice({ length: 64, format: 'symbols', bearer: true }), {
    spec: { length: 64, format: 'symbols' },
    bearer: true,
  })
  assert.equal(randomChoice({ bearer: 'true' }).bearer, false)
  assert.throws(() => randomChoice({ length: 7, bearer: true }), /between 8 and 256/)
})

test('makeRandom makes a new Bearer secret under the prefix, keeping length and format as its recipe', () => {
  const rec = recordingRandom()
  const made = makeRandom({ spec: { length: 64, format: 'symbols' }, bearer: true }, rec.random)
  assert.match(made.value, /^Bearer /)
  assert.match(made.value.slice('Bearer '.length), SYMBOLS)
  assert.equal(made.value.length, 'Bearer '.length + 64)
  assert.deepEqual(made.recipe, { kind: 'bearer', token: { length: 64, format: 'symbols' } })
})

test('canRotate offers Rotate only where remake can make the next value', () => {
  assert.equal(canRotate(null), true)
  assert.equal(canRotate({ kind: 'random', length: 32, format: 'hex' }), true)
  assert.equal(canRotate({ kind: 'bearer', token: { length: 32, format: 'hex' } }), true)
  assert.equal(canRotate({ kind: 'typed' }), false)
  assert.equal(canRotate({ kind: 'basic', login: 'alice' }), false)
  assert.equal(canRotate({ kind: 'login', login: 'alice' }), false)
})

// ── makeTyped (the field), makeLoginPassword (Set password…) ─────────────

test('makeTyped keeps a plain value as it is, recorded as typed', () => {
  assert.deepEqual(makeTyped('sk-123'), { value: 'sk-123', recipe: { kind: 'typed' } })
})

test('makeLoginPassword with Basic stores admin / pw as exactly "Basic YWRtaW46cHc=", keeping the login only', () => {
  const made = makeLoginPassword('admin', 'pw', true)
  assert.equal(made.value, 'Basic YWRtaW46cHc=')
  assert.deepEqual(made.recipe, { kind: 'basic', login: 'admin' })
})

test('makeLoginPassword without Basic stores admin / pw as exactly "admin:pw", keeping the login only', () => {
  const made = makeLoginPassword('admin', 'pw', false)
  assert.equal(made.value, 'admin:pw')
  assert.deepEqual(made.recipe, { kind: 'login', login: 'admin' })
})

test('makeLoginPassword with Basic encodes UTF-8 and keeps colons in the password', () => {
  // base64("bob:ä:x") with ä as UTF-8 (c3 a4)
  assert.equal(
    makeLoginPassword('bob', 'ä:x', true).value,
    `Basic ${Buffer.from([0x62, 0x6f, 0x62, 0x3a, 0xc3, 0xa4, 0x3a, 0x78]).toString('base64')}`,
  )
})

test('makeLoginPassword refuses a login that is empty, holds a colon or is not a string, and an empty password', () => {
  for (const basic of [true, false]) {
    assert.throws(() => makeLoginPassword('', 'pw', basic), /login is required/)
    assert.throws(() => makeLoginPassword('a:b', 'pw', basic), /cannot contain ":"/)
    assert.throws(() => makeLoginPassword(7, 'pw', basic), /login is required/)
    assert.throws(() => makeLoginPassword('admin', '', basic), /password is required/)
    assert.throws(() => makeLoginPassword('admin', undefined, basic), /password is required/)
  }
})
