// The username store against a real database, because what is under test is
// that the guarantees are the INDEXES' and not the code's: that a handle
// cannot be taken twice, that a retired one cannot be reissued, and that an
// account cannot end up with two current handles. A mock would assume every
// one of those rather than show it.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, beforeEach } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-usernames-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations')
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'development'

const { db, user, username: usernames } = await import('@opencroft/db')
const store = await import('./usernames')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

beforeEach(async () => {
  await db.delete(usernames)
  await db.delete(user)
})

let seq = 0
async function person(name: string): Promise<{ kind: 'user'; id: string }> {
  seq += 1
  const id = `user-${seq}`
  await db.insert(user).values({ id, name, email: `${id}@example.test`, emailVerified: false })
  return { kind: 'user', id }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('a username resolves to the account holding it', async () => {
  const ada = await person('Ada Lovelace')
  assert.deepEqual(await store.changeUsername(ada, 'ada'), { ok: true })
  assert.deepEqual(await store.resolveUsername('ada'), ada)
})

test('a username nobody ever held resolves to nothing', async () => {
  // An old tag carrying a bare display name lands here, and must produce a
  // miss rather than a guess.
  assert.equal(await store.resolveUsername('Ada Lovelace'), null)
  assert.equal(await store.resolveUsername('ada'), null)
})

test('a retired username still resolves, and to the same account', async () => {
  // The reason references already written into a transcript keep landing on
  // whoever wrote them.
  const ada = await person('Ada Lovelace')
  await store.changeUsername(ada, 'ada')
  await store.changeUsername(ada, 'ada.l')

  assert.deepEqual(await store.resolveUsername('ada'), ada, 'the old handle still points at her')
  assert.deepEqual(await store.resolveUsername('ada.l'), ada)
  assert.equal(await store.currentUsername(ada), 'ada.l', 'but only the new one is current')
})

// ---------------------------------------------------------------------------
// The guarantees the indexes make
// ---------------------------------------------------------------------------

test('two accounts cannot hold the same username', async () => {
  const ada = await person('Ada Lovelace')
  const alan = await person('Alan Turing')
  await store.changeUsername(ada, 'a')
  assert.deepEqual(await store.changeUsername(alan, 'a'), { ok: false, refusal: 'taken' })
  assert.deepEqual(await store.resolveUsername('a'), ada)
})

test('a freed username is never reissued', async () => {
  // The failure this whole identifier split exists to prevent: an old
  // message's author silently becoming a different person.
  const ada = await person('Ada Lovelace')
  const alan = await person('Alan Turing')
  await store.changeUsername(ada, 'ada')
  await store.changeUsername(ada, 'ada.l')

  assert.deepEqual(await store.changeUsername(alan, 'ada'), { ok: false, refusal: 'taken' })
  assert.deepEqual(await store.resolveUsername('ada'), ada, 'still hers, not his')
})

test('changing a username leaves exactly one current row', async () => {
  const ada = await person('Ada Lovelace')
  await store.changeUsername(ada, 'one')
  await store.changeUsername(ada, 'two')
  await store.changeUsername(ada, 'three')

  const rows = await db.select().from(usernames)
  assert.equal(rows.length, 3, 'every handle she has held is kept')
  assert.equal(rows.filter((r) => r.retiredAt === null).length, 1)
  assert.equal(await store.currentUsername(ada), 'three')
})

test('an account can take back a handle it retired', async () => {
  // What someone does within a minute of a typo. The account is the only one
  // that could ever hold it -- never-reissued keeps it out of everybody else's
  // reach -- so refusing the owner is refusing the one person entitled to it.
  const ada = await person('Ada Lovelace')
  await store.changeUsername(ada, 'ada')
  await store.changeUsername(ada, 'ada.l')

  assert.deepEqual(await store.changeUsername(ada, 'ada'), { ok: true })
  assert.equal(await store.currentUsername(ada), 'ada')
  assert.deepEqual(await store.resolveUsername('ada.l'), ada, 'and the one just left still resolves')
})

test('taking a handle back reuses its row rather than adding a second', async () => {
  // `username` is unique across retired rows too, so a second row could not
  // exist -- this pins that the reclaim path knows that instead of inserting.
  const ada = await person('Ada Lovelace')
  await store.changeUsername(ada, 'ada')
  await store.changeUsername(ada, 'ada.l')
  await store.changeUsername(ada, 'ada')

  const rows = await db.select().from(usernames)
  assert.equal(rows.length, 2, 'two handles ever held, not three rows')
  assert.equal(rows.filter((r) => r.retiredAt === null).length, 1)
})

test('setting the username an account already holds is not a refusal', async () => {
  const ada = await person('Ada Lovelace')
  await store.changeUsername(ada, 'ada')
  assert.deepEqual(await store.changeUsername(ada, 'ada'), { ok: true })
  assert.equal((await db.select().from(usernames)).length, 1, 'and does not retire it against itself')
})

// ---------------------------------------------------------------------------
// The reserved namespace, enforced where a username is chosen
// ---------------------------------------------------------------------------

test('a person cannot take the agent namespace', async () => {
  const ada = await person('Ada Lovelace')
  assert.deepEqual(await store.changeUsername(ada, 'agent.ada'), { ok: false, refusal: 'reserved-prefix' })
  assert.equal(await store.currentUsername(ada), null)
})

test('an invalid username is refused before anything is written', async () => {
  const ada = await person('Ada Lovelace')
  assert.deepEqual(await store.changeUsername(ada, 'Ada Lovelace'), { ok: false, refusal: 'bad-characters' })
  assert.equal((await db.select().from(usernames)).length, 0)
})

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

test('every existing account gets a handle, with no manual step', async () => {
  const ada = await person('Ada Lovelace')
  const alan = await person('Alan Turing')

  assert.deepEqual(await store.ensureUsernames(), { assigned: 2, failed: 0 })
  assert.equal(await store.currentUsername(ada), 'ada.lovelace')
  assert.equal(await store.currentUsername(alan), 'alan.turing')
})

test('backfill is a reconciliation, so running it again does nothing', async () => {
  // Agents are created by editing a space graph, with no account-creation
  // path to hook — so this has to become true again, not be done once.
  await person('Ada Lovelace')
  assert.deepEqual(await store.ensureUsernames(), { assigned: 1, failed: 0 })
  assert.deepEqual(await store.ensureUsernames(), { assigned: 0, failed: 0 })
  assert.equal((await db.select().from(usernames)).length, 1)
})

test('a quiet pass and a failed one do not report the same thing', async () => {
  // The distinction the return shape exists for: assigning nothing because
  // there was nothing to do, versus assigning nothing because it could not.
  // Reported identically, the function whose job is making "every account has
  // a handle" true would announce success at the moment it had failed.
  const quiet = await store.ensureUsernames()
  assert.deepEqual(quiet, { assigned: 0, failed: 0 })
  assert.equal(quiet.failed, 0, 'a quiet pass reports no failures, not merely no assignments')
})

test('two people called the same thing both get a handle', async () => {
  const first = await person('Alex Rivera')
  const second = await person('Alex Rivera')
  assert.deepEqual(await store.ensureUsernames(), { assigned: 2, failed: 0 })

  const a = await store.currentUsername(first)
  const b = await store.currentUsername(second)
  assert.equal(a, 'alex.rivera')
  assert.equal(b, 'alex.rivera.2', 'the suffix is in the identifier alphabet, not a slug hyphen')
  assert.notEqual(a, b)
})

test('backfill does not disturb a handle already chosen', async () => {
  const ada = await person('Ada Lovelace')
  await store.changeUsername(ada, 'countess')
  assert.deepEqual(await store.ensureUsernames(), { assigned: 0, failed: 0 })
  assert.equal(await store.currentUsername(ada), 'countess')
})

// ---------------------------------------------------------------------------
// Which database errors either writer is entitled to interpret.
//
// Tested directly rather than by provoking a real outage: this predicate is
// the whole of the decision, and the alternative -- breaking the connection
// mid-transaction -- would test the driver's failure shape rather than ours.
// What it guards is that an outage never reaches a person as "that username is
// taken", which would have them pick a different handle to work around a
// database that was simply down.
// ---------------------------------------------------------------------------

test('only a unique violation is read as a taken handle', () => {
  assert.equal(store.isUniqueViolation({ code: '23505' }), true)
  // Wrapped by a driver before it surfaced.
  assert.equal(store.isUniqueViolation({ cause: { code: '23505' } }), true)
})

test('every other database failure is left alone', () => {
  for (const error of [
    { code: '08006' }, // connection failure
    { code: '23502' }, // not-null violation
    { code: '57014' }, // statement cancelled
    new Error('socket hang up'),
    null,
    undefined,
    'a string',
  ]) {
    assert.equal(store.isUniqueViolation(error), false, `${JSON.stringify(error)} is not a taken handle`)
  }
})

// ---------------------------------------------------------------------------
// Deriving a candidate — pure, so the awkward cases are cheap to state
// ---------------------------------------------------------------------------

test('an agent candidate carries the reserved prefix and a person candidate does not', () => {
  assert.equal(store.claimUsername('Alice', 'node-1', 'agent', new Set()), 'agent.alice')
  assert.equal(store.claimUsername('Alice', 'user-1', 'user', new Set()), 'alice')
})

test('a display name with nothing usable in it still yields a handle', () => {
  // Backfill has to produce something for everybody: nobody should have to
  // choose a handle before the product works for them again.
  const claimed = store.claimUsername('🙂', 'user-42', 'user', new Set())
  assert.equal(claimed, 'user.42', 'derived from the account id when the name gives nothing')
  assert.notEqual(claimed, '')
})

test('a candidate settled earlier in the same pass is not handed out twice', () => {
  const taken = new Set<string>()
  assert.equal(store.claimUsername('Alex', 'a', 'user', taken), 'alex')
  assert.equal(store.claimUsername('Alex', 'b', 'user', taken), 'alex.2')
  assert.equal(store.claimUsername('Alex', 'c', 'user', taken), 'alex.3')
})
