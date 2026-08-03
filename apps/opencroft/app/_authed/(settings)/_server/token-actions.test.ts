// Verifies the two properties that stay non-negotiable regardless of the
// "no test gate" pass this shipped under: the secret is returned exactly
// once, and storage is hash-only. Against a real throwaway PGlite database,
// not mocks — the point is that the table definition, the migration and the
// query actually agree.
//
// PGLITE_PATH and the migrations folder are set before importing anything
// that touches the db package — `@opencroft/db` opens the connection and
// migrates at import time, so the environment has to be in place first.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-token-actions-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'db', 'migrations')
delete process.env.DATABASE_URL

const { apiToken, db, user } = await import('@opencroft/db')
const { createTokenForUser, listTokensForUser, revokeTokenForUser } = await import('./token-actions-impl')
const { resolveCaller } = await import('@/app/_authed/(mcp)/_server/caller')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

async function makeUser(email: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(user).values({ id, name: email, email, emailVerified: false })
  return id
}

function req(token: string): Request {
  return new Request('http://localhost:9999/api/mcp', { headers: { authorization: `Bearer ${token}` } })
}

test('the created token is returned once and is not stored anywhere retrievable', async () => {
  const userId = await makeUser('alice@example.test')
  const created = await createTokenForUser(userId, { name: 'laptop' })

  assert.match(created.token, /^oc_/)

  const all = await db.select().from(apiToken)
  const stored = all.find((r) => r.id === created.id)
  assert.ok(stored, 'the row must exist')

  // The whole row, serialised, must not contain the plaintext token anywhere.
  const serialized = JSON.stringify(stored)
  assert.ok(!serialized.includes(created.token), 'the plaintext token must not appear in the stored row at all')
  assert.notEqual(stored.tokenHash, created.token, 'tokenHash must not equal the plaintext token')
  assert.equal(stored.tokenHash.length, 64, 'tokenHash must be a sha256 hex digest, not the token itself')

  const list = await listTokensForUser(userId)
  const listedSerialized = JSON.stringify(list)
  assert.ok(!listedSerialized.includes(created.token), 'the plaintext token must never come back from list either')
  assert.ok(
    !Object.keys(list[0] ?? {}).some((k) => k.toLowerCase().includes('token')),
    'MyToken must carry no field that could hold a secret',
  )
})

test('a name is required', async () => {
  const userId = await makeUser('bob@example.test')
  await assert.rejects(() => createTokenForUser(userId, { name: '' }))
  await assert.rejects(() => createTokenForUser(userId, { name: '   ' }))
})

test('expiry defaults to roughly 90 days out when omitted', async () => {
  const userId = await makeUser('carol@example.test')
  const created = await createTokenForUser(userId, { name: 'default-expiry' })
  const [row] = (await listTokensForUser(userId)).filter((r) => r.id === created.id)
  assert.ok(row.expiresAt, 'a personal token must never be issued with no expiry at all')

  const days = (new Date(row.expiresAt as string).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  assert.ok(days > 89 && days < 91, `expected ~90 days out, got ${days.toFixed(1)}`)
})

test('an expiry in the past is refused, so a mistake cannot mint a dead-on-arrival token', async () => {
  const userId = await makeUser('dave@example.test')
  await assert.rejects(() => createTokenForUser(userId, { name: 'already-expired', expiresAt: '2020-01-01' }))
})

test("one user cannot list or revoke another user's token", async () => {
  const owner = await makeUser('eve@example.test')
  const attacker = await makeUser('mallory@example.test')

  const created = await createTokenForUser(owner, { name: 'private' })

  const attackerList = await listTokensForUser(attacker)
  assert.equal(
    attackerList.some((t) => t.id === created.id),
    false,
    'a token must not appear in a list scoped to a different user',
  )

  await assert.rejects(
    () => revokeTokenForUser(attacker, created.id),
    "revoking someone else's token id must fail exactly as if the id did not exist",
  )

  const ownerList = await listTokensForUser(owner)
  assert.equal(
    ownerList.find((t) => t.id === created.id)?.revokedAt,
    null,
    'the attempted revoke by a non-owner must not have revoked it',
  )
})

test('revoking takes effect immediately against the same verification path /api/mcp uses', async () => {
  const userId = await makeUser('frank@example.test')
  const created = await createTokenForUser(userId, { name: 'to-be-revoked' })

  const before = await resolveCaller(req(created.token))
  assert.equal(before.credential, 'present', 'must resolve before revocation, or this test proves nothing')

  await revokeTokenForUser(userId, created.id)

  const after_ = await resolveCaller(req(created.token))
  assert.equal(after_.credential, 'unknown', 'a revoked personal token must stop resolving immediately, no cache')
})

test('an expired personal token stops resolving on its own, without being revoked', async () => {
  const userId = await makeUser('grace@example.test')
  const created = await createTokenForUser(userId, { name: 'to-expire' })

  // Backdate it directly — createTokenForUser refuses a past expiresAt at
  // creation time, so an already-expired token is only reachable by aging one
  // out, which is exactly what happens in production over 90 days.
  const { eq } = await import('drizzle-orm')
  await db
    .update(apiToken)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(apiToken.id, created.id))

  const result = await resolveCaller(req(created.token))
  assert.equal(result.credential, 'unknown', 'an expired token must resolve as unknown, same as a revoked one')
})
