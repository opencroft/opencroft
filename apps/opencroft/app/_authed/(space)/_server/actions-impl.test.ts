// The delete guard, against a real throwaway PGlite database rather than a
// stand-in registry. What the guard reads is "how many spaces are there", and a
// stub is free to answer that however the test would like it answered -- which
// is the one thing this must not be free to do.
//
// PGLITE_PATH and the migrations folder are set before importing anything that
// touches the db package -- `@opencroft/db` opens the connection and migrates at
// import time, so the environment has to be in place first. A datadir of its own
// also gives the suite the state it is about: a workspace holding exactly one
// space, which a datadir shared with every other suite never is.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { DEFAULT_SPACE_SLUG } from './types'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-space-actions-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
)
delete process.env.DATABASE_URL

const { createSpaceImpl, deleteSpaceImpl, registry, renameSpaceImpl } = await import('./actions-impl')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

// The case this was filed for. A renamed default space stops answering to
// `default` at all, so a guard that asked for that slug stopped protecting the
// only space in the workspace the moment renaming shipped -- and the workspace
// it left behind is not empty for long, because loading recreates a default
// space, but the graph that was in the deleted one does not come back with it.
test('the last space stays protected after a rename has moved its address', async () => {
  const r = await registry()
  assert.deepEqual(
    r.list().map((s) => s.slug),
    [DEFAULT_SPACE_SLUG],
    'precondition: a fresh workspace holds exactly the default space',
  )
  const only = r.list()[0]

  const renamed = await renameSpaceImpl({ slug: only.slug, name: 'Workshop' })
  if (!renamed.ok) {
    assert.fail(`the rename has to land before the delete is interesting: ${renamed.code}`)
  }
  assert.equal(renamed.space.slug, 'workshop', 'the address follows the name -- what makes this reachable')

  assert.equal(await deleteSpaceImpl('workshop'), false, 'the only space is not deletable under its new address')
  assert.equal(
    await deleteSpaceImpl(DEFAULT_SPACE_SLUG),
    false,
    'nor under the address the rename freed, which still resolves to it',
  )
  assert.deepEqual(
    r.list().map((s) => s.id),
    [only.id],
    'and it is still there -- a refusal that deleted it anyway is the failure this catches',
  )
})

// The other half of the rule: a guard that refused everything would pass the
// test above. This is also where the deliberate behaviour change is pinned --
// the space left over here was never the default one.
test('deleting works while another space remains, and the last one is refused whatever it is called', async () => {
  const r = await registry()
  const before = r.list()
  assert.equal(before.length, 1, 'precondition: still down to one space')

  const second = await createSpaceImpl('Field Notes')
  assert.equal(r.list().length, 2)
  assert.notEqual(second.slug, DEFAULT_SPACE_SLUG, 'a space that never held the default address')

  assert.equal(await deleteSpaceImpl(before[0].slug), true, 'with two spaces, deleting one is ordinary')

  assert.deepEqual(
    r.list().map((s) => s.slug),
    [second.slug],
  )
  assert.equal(await deleteSpaceImpl(second.slug), false, 'and now it is the last one, so it is refused in its turn')
  assert.equal(r.list().length, 1, 'a workspace cannot be emptied of spaces')
})
