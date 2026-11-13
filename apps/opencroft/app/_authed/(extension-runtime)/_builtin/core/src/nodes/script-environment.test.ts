import assert from 'node:assert/strict'
import test from 'node:test'

import { environmentPatch, envNameProblem, readEnvironment, resolveEnvironment } from './script-environment'

// Stands in for the host's resolver: a stored `secret:<NAME>` value becomes a value naming the secret.
const resolved = (stored: string) => Promise.resolve(`resolved(${stored})`)

// ── The line form ─────────────────────────────────────────────────────────

test('the line form runs with one KEY=VALUE pair per line', async () => {
  assert.deepEqual(await resolveEnvironment({ env: 'NODE_ENV=production\nDEBUG=false' }, resolved), {
    NODE_ENV: 'production',
    DEBUG: 'false',
  })
})

test('the line form trims lines and skips blank ones', async () => {
  assert.deepEqual(await resolveEnvironment({ env: '  A=1  \n\n  \nB=2\n' }, resolved), { A: '1', B: '2' })
})

test('the line form keeps "=" characters inside the value', async () => {
  assert.deepEqual(await resolveEnvironment({ env: 'QUERY=a=b=c' }, resolved), { QUERY: 'a=b=c' })
})

test('the line form ignores a line with no "="', async () => {
  assert.deepEqual(await resolveEnvironment({ env: 'NOEQUALS\nA=1' }, resolved), { A: '1' })
})

test('the line form injects each name in `secrets` under its own name, over a typed line of that name', async () => {
  const data = { env: 'TOKEN=typed\nA=1', secrets: '  TOKEN  \n\nOTHER\n  ' }
  assert.deepEqual(await resolveEnvironment(data, resolved), {
    TOKEN: 'resolved(secret:TOKEN)',
    A: '1',
    OTHER: 'resolved(secret:OTHER)',
  })
  assert.deepEqual(readEnvironment(data), [
    { name: 'TOKEN', secret: 'TOKEN' },
    { name: 'A', value: '1' },
    { name: 'OTHER', secret: 'OTHER' },
  ])
})

test('a node with no environment runs with none', async () => {
  assert.deepEqual(await resolveEnvironment({}, resolved), {})
  assert.deepEqual(await resolveEnvironment({ env: '', secrets: '' }, resolved), {})
})

// ── The stored form ───────────────────────────────────────────────────────

test('the stored form reads typed values and secrets by name, in order', () => {
  assert.deepEqual(readEnvironment({ env: { PORT: '8080', TOKEN: 'secret: API_TOKEN', EMPTY: '' } }), [
    { name: 'PORT', value: '8080' },
    { name: 'TOKEN', secret: 'API_TOKEN' },
    { name: 'EMPTY', value: '' },
  ])
})

test('the stored form skips a value that is not text', () => {
  assert.deepEqual(readEnvironment({ env: { PORT: 8080, HOST: 'localhost' } }), [{ name: 'HOST', value: 'localhost' }])
})

test('a secret in the stored form is resolved from its stored value', async () => {
  assert.deepEqual(await resolveEnvironment({ env: { TOKEN: 'secret:API_TOKEN', A: '1' } }, resolved), {
    TOKEN: 'resolved(secret:API_TOKEN)',
    A: '1',
  })
})

test('a secret that does not resolve fails the whole environment', async () => {
  const failing = () => Promise.reject(new Error('No secret "MISSING"'))
  await assert.rejects(resolveEnvironment({ env: { TOKEN: 'secret:MISSING' } }, failing), /MISSING/)
})

test('a prototype name becomes a variable of its own, not the prototype', async () => {
  const env = await resolveEnvironment({ env: '__proto__=x' }, resolved)
  assert.equal(Object.getPrototypeOf(env), Object.prototype)
  assert.equal(Object.hasOwn(env, '__proto__'), true)
})

// ── Writing back ──────────────────────────────────────────────────────────

test('a write stores the object and drops the secrets field of the line form', () => {
  const patch = environmentPatch(readEnvironment({ env: 'A=1', secrets: 'TOKEN' }))
  assert.deepEqual(patch, { env: { A: '1', TOKEN: 'secret:TOKEN' }, secrets: undefined })
  assert.ok(Object.hasOwn(patch, 'secrets'), 'secrets is present as undefined, which removes it from node data')
})

test('a written environment reads back as written', () => {
  const variables = [
    { name: 'B', value: '2' },
    { name: 'TOKEN', secret: 'API_TOKEN' },
    { name: 'A', value: '' },
  ]
  assert.deepEqual(readEnvironment(environmentPatch(variables)), variables)
})

test('a write leaves out an empty name and a prototype key', () => {
  const { env } = environmentPatch([
    { name: '', value: 'x' },
    { name: '__proto__', value: 'x' },
    { name: 'A', value: '1' },
  ])
  assert.deepEqual(Object.keys(env), ['A'])
  assert.equal(({} as Record<string, unknown>).x, undefined)
})

// ── Names ─────────────────────────────────────────────────────────────────

test('a variable name may not be empty, hold whitespace or "=", or be a prototype key', () => {
  assert.equal(envNameProblem('NODE_ENV'), undefined)
  assert.match(envNameProblem('') ?? '', /needs a name/)
  assert.match(envNameProblem('A B') ?? '', /whitespace/)
  assert.match(envNameProblem('A=B') ?? '', /equals/)
  assert.match(envNameProblem('constructor') ?? '', /cannot be used/)
})
