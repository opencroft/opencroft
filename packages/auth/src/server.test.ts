// Exercises the first-run admin rule against a real (throwaway) database, not
// a mock: the thing worth proving is that Better Auth's adapter, our table
// definitions and the migrations actually agree, which a mock would hide.
//
// PGLITE_PATH and the migrations folder are set before importing anything that
// touches the db package — `@opencroft/db` opens the connection and migrates at
// import time, so the environment has to be in place first.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-auth-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db', 'migrations')
process.env.BETTER_AUTH_SECRET = 'test-secret-not-a-real-one'
delete process.env.DATABASE_URL

const { countUsers, createFirstAdmin, getSessionUser } = await import('./server')

const ADMIN = { name: 'First Admin', email: 'admin@example.test', password: 'correct horse battery staple' }

before(async () => {
  assert.equal(await countUsers(), 0, 'the throwaway database must start empty')
})

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

test('an empty database reports no users, which is what puts the app in setup', async () => {
  assert.equal(await countUsers(), 0)
})

test('the first account is created and is an administrator', async () => {
  await createFirstAdmin(ADMIN)
  assert.equal(await countUsers(), 1)

  const { db } = await import('@opencroft/db')
  const { user } = await import('@opencroft/db/schema')
  const rows = await db.select().from(user)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].email, ADMIN.email)
  assert.equal(rows[0].role, 'admin', 'the first account must be an admin, not a plain user')
})

test('setup refuses to run a second time', async () => {
  await assert.rejects(
    createFirstAdmin({ name: 'Second', email: 'second@example.test', password: 'another long passphrase' }),
    /already been completed/,
    'a re-runnable setup route would be a way to mint admins',
  )
  assert.equal(await countUsers(), 1, 'the refused call must not have created anything')
})

// The production container leaves NODE_ENV unset, so "not production" would
// hand it the placeholder published in this repo. These pin the direction the
// fallback is gated in, since getting it backwards is silent.
test('an unset NODE_ENV with no secret refuses, rather than taking the placeholder', async () => {
  const { BETTER_AUTH_SECRET, NODE_ENV } = process.env
  delete process.env.BETTER_AUTH_SECRET
  delete process.env.NODE_ENV
  try {
    const fresh = await import(`./server?secret-unset-${Date.now()}`)
    assert.throws(() => fresh.ensureAuth(), /BETTER_AUTH_SECRET is not set/)
  } finally {
    process.env.BETTER_AUTH_SECRET = BETTER_AUTH_SECRET
    if (NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = NODE_ENV
    }
  }
})

test('the failure names the variable and only bites on use, not on import', async () => {
  const { BETTER_AUTH_SECRET } = process.env
  delete process.env.BETTER_AUTH_SECRET
  try {
    // Importing must not throw — an unconfigured deployment has to boot and
    // serve its pages; only reaching for auth may fail.
    const fresh = await import(`./server?lazy-${Date.now()}`)
    assert.equal(typeof fresh.ensureAuth, 'function', 'the module must import cleanly without a secret')
    assert.throws(() => fresh.ensureAuth(), /BETTER_AUTH_SECRET/)
  } finally {
    process.env.BETTER_AUTH_SECRET = BETTER_AUTH_SECRET
  }
})

test('a request with no cookies has no user', async () => {
  const anonymous = await getSessionUser(new Request('http://localhost/'))
  assert.equal(anonymous, null)
})

test('signing in yields a session that resolves back to the same user', async () => {
  const { ensureAuth } = await import('./server')
  const response = await ensureAuth().api.signInEmail({
    body: { email: ADMIN.email, password: ADMIN.password },
    asResponse: true,
  })
  assert.equal(response.status, 200, 'the admin created above must be able to sign in')

  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie, 'sign-in must set a session cookie')

  const identified = await getSessionUser(new Request('http://localhost/', { headers: { cookie } }))
  assert.ok(identified, 'the session cookie must resolve to a user')
  assert.equal(identified.email, ADMIN.email)
})
