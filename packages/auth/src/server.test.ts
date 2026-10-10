// Exercises the first-run admin rule against a real (throwaway) database, not
// a mock: the thing worth proving is that Better Auth's adapter, our table
// definitions and the migrations actually agree, which a mock would hide.
//
// OPENCROFT_PGLITE_PATH and the migrations folder are set before importing
// anything that touches the db package — `@opencroft/db` opens the connection
// and migrates at import time, so the environment has to be in place first.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-auth-test-'))
process.env.OPENCROFT_PGLITE_PATH = join(workdir, 'pglite')
process.env.OPENCROFT_DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'db', 'migrations')
process.env.OPENCROFT_AUTH_SECRET = 'test-secret-not-a-real-one'
// The database code honours each variable's former name too, so an ambient
// one must not reach this throwaway database either.
for (const name of [
  'OPENCROFT_DATABASE_URL',
  'DATABASE_URL',
  'PGLITE_PATH',
  'DB_MIGRATIONS_DIR',
  'BETTER_AUTH_SECRET',
]) {
  delete process.env[name]
}

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

// Both of the following end the same way if they regress: an instance with an
// account but no administrator, and setup refusing to run again — nobody can
// administer it and no route is left that would fix it.
test('two concurrent setups on an EMPTY instance produce one account, not two', async () => {
  const { db } = await import('@opencroft/db')
  const { user } = await import('@opencroft/db/schema')
  await db.delete(user)
  assert.equal(await countUsers(), 0, 'the race only exists on an empty instance')

  // Fired together with different addresses, which is the case a unique
  // constraint on email would NOT catch: the hazard is both passing the
  // "is it empty" check before either writes.
  const outcomes = await Promise.allSettled([
    createFirstAdmin({ name: 'Race A', email: 'race-a@example.test', password: 'a long enough passphrase' }),
    createFirstAdmin({ name: 'Race B', email: 'race-b@example.test', password: 'a long enough passphrase' }),
  ])

  const created = outcomes.filter((outcome) => outcome.status === 'fulfilled')
  const refused = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(created.length, 1, 'exactly one submission may win')
  assert.equal(refused.length, 1, 'the other must be refused, not silently succeed')
  assert.equal(await countUsers(), 1, 'two administrators is the failure this guards against')

  const rows = await db.select().from(user)
  assert.equal(rows[0].role, 'admin', 'the one that won must still be a real admin')

  // Restore the state the remaining tests were written against.
  await db.delete(user)
  await createFirstAdmin(ADMIN)
})

test('a failed promotion removes the account, so setup stays runnable', async () => {
  const { db } = await import('@opencroft/db')
  const { user } = await import('@opencroft/db/schema')
  await db.delete(user)
  assert.equal(await countUsers(), 0, 'starting from an empty instance')

  // Make the promotion fail the way a real one would — the update runs but
  // matches nothing, which leaves an account behind that is not an admin.
  const original = db.update
  ;(db as { update: unknown }).update = ((table: unknown) => {
    const builder = original.call(db, table as never)
    return {
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    } as unknown as typeof builder
  }) as typeof db.update

  try {
    await assert.rejects(
      createFirstAdmin({ name: 'Half', email: 'half@example.test', password: 'a long enough passphrase' }),
      /could not be made an administrator/,
    )
  } finally {
    ;(db as { update: unknown }).update = original
  }

  assert.equal(
    await countUsers(),
    0,
    'the half-created account must be gone — otherwise setup refuses forever with no admin',
  )

  // And setup must genuinely still work afterwards. Re-creating the original
  // admin rather than some other account also restores exactly the state the
  // remaining tests were written against.
  await createFirstAdmin(ADMIN)
  const rows = await db.select().from(user)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].email, ADMIN.email)
  assert.equal(rows[0].role, 'admin')
})

// The address as typed is not necessarily the address as stored — lowercasing
// on write is usual. Anything that matches on the typed form would find no row
// here: the promotion would fail, the rollback would delete nothing, and the
// instance would be left un-administerable with setup closed.
test('a mixed-case address still yields an administrator', async () => {
  const { db } = await import('@opencroft/db')
  const { user } = await import('@opencroft/db/schema')
  await db.delete(user)

  await createFirstAdmin({
    name: 'Mixed Case',
    email: 'Admin@Example.COM',
    password: 'a long enough passphrase',
  })

  const rows = await db.select().from(user)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'admin', 'the account must be an admin regardless of how the address was cased')

  await db.delete(user)
  await createFirstAdmin(ADMIN)
})

test('setup stays usable when the database cannot hand out a connection', async () => {
  const { db } = await import('@opencroft/db')
  const client = (db as { $client?: { connect?: unknown } }).$client
  assert.ok(client, 'the driver handle must be reachable for this test to mean anything')

  // These tests run on the embedded driver, which takes no connection and so
  // cannot fail this way on its own. Rather than skip — a silently skipped
  // test is indistinguishable from a passing one — give it a `connect` that
  // fails, which is exactly the pooled shape being guarded against.
  const original = (client as { connect?: unknown }).connect
  ;(client as { connect?: unknown }).connect = () => Promise.reject(new Error('pool exhausted'))
  try {
    await assert.rejects(
      createFirstAdmin({ name: 'Nope', email: 'nope2@example.test', password: 'a long enough passphrase' }),
      /pool exhausted/,
    )
  } finally {
    if (original === undefined) {
      delete (client as { connect?: unknown }).connect
    } else {
      ;(client as { connect?: unknown }).connect = original
    }
  }

  // The point of the test: a failed acquisition must not leave the queue held,
  // or every later attempt waits on a promise that never settles.
  await assert.rejects(
    createFirstAdmin({ name: 'After', email: 'after@example.test', password: 'a long enough passphrase' }),
    /already been completed/,
    'a later setup must still reach a real answer rather than hanging',
  )
})

test('setup refuses to run a second time', async () => {
  await assert.rejects(
    createFirstAdmin({ name: 'Second', email: 'second@example.test', password: 'another long passphrase' }),
    /already been completed/,
    'a re-runnable setup route would be a way to mint admins',
  )
  assert.equal(await countUsers(), 1, 'the refused call must not have created anything')
})

// Runs `body` with the auth secret unset under both its names and the data
// directory, where the key file lives, moved to a directory of its own.
async function withoutConfiguredSecret(body: (keyFile: string) => Promise<void>): Promise<void> {
  const { OPENCROFT_AUTH_SECRET, OPENCROFT_DATA_DIR } = process.env
  const dataDir = await mkdtemp(join(workdir, 'data-'))
  delete process.env.OPENCROFT_AUTH_SECRET
  process.env.OPENCROFT_DATA_DIR = dataDir
  try {
    await body(join(dataDir, 'instance-secrets.json'))
  } finally {
    process.env.OPENCROFT_AUTH_SECRET = OPENCROFT_AUTH_SECRET
    delete process.env.BETTER_AUTH_SECRET
    if (OPENCROFT_DATA_DIR === undefined) {
      delete process.env.OPENCROFT_DATA_DIR
    } else {
      process.env.OPENCROFT_DATA_DIR = OPENCROFT_DATA_DIR
    }
  }
}

test('with no auth secret set, sessions are signed with a key generated into the key file and reused', async () => {
  await withoutConfiguredSecret(async (keyFile) => {
    const first = await import(`./server?generated-${Date.now()}`)
    // Importing must not touch the file: a key file that cannot be read would
    // otherwise take the whole app down at boot rather than only sign-in.
    assert.equal(existsSync(keyFile), false, 'importing the module must not create the key file')

    const secret = (await first.ensureAuth().$context).secret
    const saved = JSON.parse(readFileSync(keyFile, 'utf8')).OPENCROFT_AUTH_SECRET
    assert.equal(secret, saved, 'the secret in use is the one saved in the key file')
    assert.ok(secret.length >= 32, 'a generated secret is long enough for Better Auth')

    // A second build, as after a restart, reads the same key back.
    const second = await import(`./server?reused-${Date.now()}`)
    assert.equal((await second.ensureAuth().$context).secret, saved)
  })
})

test('OPENCROFT_AUTH_SECRET, when set, wins over the key file', async () => {
  await withoutConfiguredSecret(async (keyFile) => {
    writeFileSync(keyFile, JSON.stringify({ OPENCROFT_AUTH_SECRET: 'from-the-file-not-a-real-one-0123456789' }))
    process.env.OPENCROFT_AUTH_SECRET = 'from-the-env-not-a-real-one-0123456789'
    const fresh = await import(`./server?env-wins-${Date.now()}`)
    assert.equal((await fresh.ensureAuth().$context).secret, 'from-the-env-not-a-real-one-0123456789')
  })
})

test('the former BETTER_AUTH_SECRET alone still signs sessions', async () => {
  await withoutConfiguredSecret(async (keyFile) => {
    process.env.BETTER_AUTH_SECRET = 'from-the-former-name-not-a-real-one-0123'
    const fresh = await import(`./server?former-${Date.now()}`)
    assert.equal((await fresh.ensureAuth().$context).secret, 'from-the-former-name-not-a-real-one-0123')
    assert.equal(existsSync(keyFile), false, 'an environment value is never written to the key file')
  })
})

// Better Auth reads BETTER_AUTH_SECRET itself when no `secret` is passed, so
// this is what shows the library is handed ours rather than finding its own.
test('with both names set, Better Auth is handed OPENCROFT_AUTH_SECRET', async () => {
  await withoutConfiguredSecret(async () => {
    process.env.OPENCROFT_AUTH_SECRET = 'from-the-new-name-not-a-real-one-012345'
    process.env.BETTER_AUTH_SECRET = 'from-the-former-name-not-a-real-one-0123'
    const fresh = await import(`./server?both-${Date.now()}`)
    assert.equal((await fresh.ensureAuth().$context).secret, 'from-the-new-name-not-a-real-one-012345')
  })
})

// Registration over HTTP must be refused by us, not left to a library default
// or to origin checking. Better Auth's 403 for a missing Origin looks like this
// is already handled — it is not, and it does not even behave the same
// everywhere: on the deployed development build a request with no Origin
// reaches password validation instead of being refused.
test('registration over HTTP is refused, whatever Origin it carries', async () => {
  const { handleAuthRequest } = await import('./server')

  const originVariants: Record<string, string>[] = [
    {},
    { origin: 'http://localhost' },
    { origin: 'https://elsewhere.example' },
  ]
  for (const headers of originVariants) {
    const response = await handleAuthRequest(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'Walk In', email: 'walkin@example.test', password: 'a long enough passphrase' }),
      }),
    )
    assert.equal(response.status, 403, `sign-up must be refused with headers ${JSON.stringify(headers)}`)
  }

  const { db } = await import('@opencroft/db')
  const { user } = await import('@opencroft/db/schema')
  const rows = await db.select().from(user)
  assert.ok(
    rows.every((row) => row.email !== 'walkin@example.test'),
    'a refused registration must not leave an account behind',
  )
})

test('a social provider is offered when both halves are set, under the new names or the former ones', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { configuredSocialProviders } = await import('./server')
  const names = [
    'OPENCROFT_GOOGLE_CLIENT_ID',
    'OPENCROFT_GOOGLE_CLIENT_SECRET',
    'OPENCROFT_APPLE_CLIENT_ID',
    'OPENCROFT_APPLE_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'APPLE_CLIENT_ID',
    'APPLE_CLIENT_SECRET',
  ]
  const saved = new Map(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) {
      delete process.env[name]
    }
    assert.deepEqual(configuredSocialProviders(), [])

    process.env.OPENCROFT_GOOGLE_CLIENT_ID = 'google-id'
    assert.deepEqual(configuredSocialProviders(), [], 'half a credential offers nothing')
    process.env.OPENCROFT_GOOGLE_CLIENT_SECRET = 'google-secret'
    process.env.APPLE_CLIENT_ID = 'apple-id'
    process.env.APPLE_CLIENT_SECRET = 'apple-secret'
    assert.deepEqual(configuredSocialProviders(), ['google', 'apple'])
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
})

test('the refusal covers any endpoint under /sign-up, not just the one that exists today', async () => {
  const { isSignUpRequest } = await import('./server')
  assert.equal(isSignUpRequest(new Request('http://x/api/auth/sign-up/email')), true)
  assert.equal(isSignUpRequest(new Request('http://x/api/auth/sign-up')), true)
  assert.equal(isSignUpRequest(new Request('http://x/api/auth/sign-up/phone-number')), true)
  // Everything else must still reach Better Auth — refusing sign-in would be a
  // very quiet way to lock the app.
  assert.equal(isSignUpRequest(new Request('http://x/api/auth/sign-in/email')), false)
  assert.equal(isSignUpRequest(new Request('http://x/api/auth/get-session')), false)
  assert.equal(isSignUpRequest(new Request('http://x/api/auth/sign-out')), false)
})

// The setup endpoint is reachable by anyone before the first account exists,
// so what it can be made to say matters. These pin the codes callers map on;
// the messages themselves are operator-facing and must not be returned.
test('failures carry a code to map on, not text to forward', async () => {
  const { SetupError } = await import('./server')

  const alreadyDone = await createFirstAdmin({
    name: 'Nope',
    email: 'nope@example.test',
    password: 'a long enough passphrase',
  }).then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(alreadyDone instanceof SetupError)
  assert.equal(alreadyDone.code, 'already-completed')

  // A password below the library's policy is a refusal of the details, not a
  // broken instance — the difference the screen needs in order to say
  // something useful.
  const { db } = await import('@opencroft/db')
  const { user } = await import('@opencroft/db/schema')
  await db.delete(user)
  const refused = await createFirstAdmin({ name: 'Short', email: 'short@example.test', password: 'x' }).then(
    () => null,
    (error: unknown) => error,
  )
  assert.ok(refused instanceof SetupError, 'a refused sign-up must be a SetupError, not a raw library error')
  assert.equal(refused.code, 'rejected')
  assert.equal(await countUsers(), 0, 'a refused sign-up must leave nothing behind')

  await createFirstAdmin(ADMIN)
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

test('a person stores one of the offered themes on their account, and nothing else', async () => {
  const { ensureAuth, handleAuthRequest } = await import('./server')
  const signIn = await ensureAuth().api.signInEmail({
    body: { email: ADMIN.email, password: ADMIN.password },
    asResponse: true,
  })
  const cookie = signIn.headers.get('set-cookie') as string
  // The browser's own route: the update-user endpoint over HTTP, same origin.
  const updateTheme = (theme: string) =>
    handleAuthRequest(
      new Request('http://localhost/api/auth/update-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost', cookie },
        body: JSON.stringify({ theme }),
      }),
    )
  const storedTheme = async () =>
    (await getSessionUser(new Request('http://localhost/', { headers: { cookie } })))?.theme

  assert.equal(await storedTheme(), null, 'no choice has been made yet')

  assert.equal((await updateTheme('dark')).status, 200)
  assert.equal(await storedTheme(), 'dark')

  assert.equal((await updateTheme('purple')).status, 400, 'a value outside the choices must be refused')
  assert.equal(await storedTheme(), 'dark', 'a refused value must leave the stored choice alone')
})

test('a person records when they last saw the sponsor prompt, and only as a date', async () => {
  const { ensureAuth, handleAuthRequest } = await import('./server')
  const signIn = await ensureAuth().api.signInEmail({
    body: { email: ADMIN.email, password: ADMIN.password },
    asResponse: true,
  })
  const cookie = signIn.headers.get('set-cookie') as string
  const updateSeenAt = (sponsorPromptSeenAt: string) =>
    handleAuthRequest(
      new Request('http://localhost/api/auth/update-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost', cookie },
        body: JSON.stringify({ sponsorPromptSeenAt }),
      }),
    )
  const storedSeenAt = async () =>
    (await getSessionUser(new Request('http://localhost/', { headers: { cookie } })))?.sponsorPromptSeenAt

  assert.equal(await storedSeenAt(), null, 'the prompt has not been seen yet')

  const seen = '2031-05-17T09:30:00.000Z'
  assert.equal((await updateSeenAt(seen)).status, 200)
  assert.equal((await storedSeenAt())?.toISOString(), seen)

  assert.equal((await updateSeenAt('yesterday-ish')).status, 400, 'a value that is not a date must be refused')
  assert.equal((await storedSeenAt())?.toISOString(), seen, 'a refused value must leave the stored date alone')
})

// The line between "logged out" and "silently let in". Once the route boundary
// exists, whatever getSessionUser returns IS the gate — so a session the
// database considers expired must resolve to nothing, not merely be tidied up
// on some later sweep. Asserted against a real expired row rather than by
// waiting, because the alternative is a test that sleeps or one that trusts the
// library's own clock handling without checking it.
test('an expired session resolves to null, not to its user', async () => {
  const { ensureAuth } = await import('./server')
  const { db } = await import('@opencroft/db')
  const { session } = await import('@opencroft/db/schema')
  const { lt, sql } = await import('drizzle-orm')

  const response = await ensureAuth().api.signInEmail({
    body: { email: ADMIN.email, password: ADMIN.password },
    asResponse: true,
  })
  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie, 'sign-in must set a session cookie')

  const live = await getSessionUser(new Request('http://localhost/', { headers: { cookie } }))
  assert.ok(live, 'precondition: the fresh session must resolve, or this proves nothing')

  // Backdate every session so the cookie points at an expired row.
  const past = new Date(Date.now() - 60 * 60 * 1000)
  await db.update(session).set({ expiresAt: past })
  assert.equal(
    (await db.select().from(session).where(lt(session.expiresAt, sql`now()`))).length > 0,
    true,
    'precondition: at least one session row must now be expired',
  )

  const expired = await getSessionUser(new Request('http://localhost/', { headers: { cookie } }))
  assert.equal(expired, null, 'an expired session must not resolve to a user — that would be silently letting them in')
})

// Better Auth's admin plugin deletes a user's session rows outright when it
// is banned — a derived "last seen" (the session table's own most recent
// row) would vanish at exactly the moment disabling an account is supposed
// to keep its data, per the toggle's own copy. lastSeenAt lives on the user
// row instead, set from a sign-in hook, so it survives that deletion.
test('disabling and re-enabling sign-in access does not erase when the account was last seen', async () => {
  const { createUserAsAdmin, setUserDisabledAsAdmin, getUserAsAdmin, ensureAuth } = await import('./server')

  const adminSignIn = await ensureAuth().api.signInEmail({
    body: { email: ADMIN.email, password: ADMIN.password },
    asResponse: true,
  })
  const adminCookie = adminSignIn.headers.get('set-cookie')
  assert.ok(adminCookie, 'precondition: the admin must be able to sign in')
  const adminRequest = () => new Request('http://localhost/', { headers: { cookie: adminCookie as string } })

  const account = { name: 'Watched', email: 'watched@example.test', password: 'a long enough passphrase' }
  const created = await createUserAsAdmin(adminRequest(), { ...account, role: 'user' })

  const beforeSignIn = await getUserAsAdmin(adminRequest(), created.id)
  assert.equal(
    beforeSignIn?.lastSeenAt,
    null,
    'precondition: an account that has never signed in has no last-seen date',
  )

  const signIn = await ensureAuth().api.signInEmail({
    body: { email: account.email, password: account.password },
    asResponse: true,
  })
  assert.equal(
    signIn.status,
    200,
    'precondition: the created account must be able to sign in for this test to mean anything',
  )

  const afterSignIn = await getUserAsAdmin(adminRequest(), created.id)
  assert.ok(afterSignIn?.lastSeenAt, 'signing in must record a last-seen date')
  const seenAt = afterSignIn.lastSeenAt as Date

  await setUserDisabledAsAdmin(adminRequest(), created.id, true)
  const disabled = await getUserAsAdmin(adminRequest(), created.id)
  assert.equal(disabled?.disabled, true, 'precondition: the account must actually be disabled')
  assert.deepEqual(
    disabled?.lastSeenAt,
    seenAt,
    'disabling sign-in access must not erase when the account was last seen',
  )

  await setUserDisabledAsAdmin(adminRequest(), created.id, false)
  const reenabled = await getUserAsAdmin(adminRequest(), created.id)
  assert.deepEqual(reenabled?.lastSeenAt, seenAt, 're-enabling must not have already lost it while disabled')
})
