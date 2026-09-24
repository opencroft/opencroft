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
  return new Request('http://localhost:9999/mcp', { headers: { authorization: `Bearer ${token}` } })
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

// The two tests that stood here proved revocation and expiry against the MCP
// endpoint's resolver, which was then the one place a personal token was
// accepted. The endpoint now takes MCP tokens only, so that path refuses a
// personal token whatever its state; what is left to prove here is that
// revoking is recorded, and that a live personal token does not open it.
test('revoking marks the token revoked, and it stays listed', async () => {
  const userId = await makeUser('frank@example.test')
  const created = await createTokenForUser(userId, { name: 'to-be-revoked' })

  const { revokedAt } = await revokeTokenForUser(userId, created.id)

  const listed = (await listTokensForUser(userId)).find((t) => t.id === created.id)
  assert.equal(listed?.revokedAt, revokedAt, 'a revoked token must still be listed, showing when it was revoked')
})

test('a live personal token does not resolve on the MCP endpoint', async () => {
  const userId = await makeUser('grace@example.test')
  const created = await createTokenForUser(userId, { name: 'not-for-mcp' })

  const result = await resolveCaller(req(created.token))
  assert.equal(result.credential, 'unknown', 'a personal token must never identify an MCP caller')
  assert.equal(result.agentNodeId, null)
})
