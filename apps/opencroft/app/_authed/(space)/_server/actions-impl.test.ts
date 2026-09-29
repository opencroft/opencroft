// Space creation and deletion against a real throwaway PGlite database rather
// than a stand-in registry, so what the registry loads is what the database
// holds.
//
// PGLITE_PATH and the migrations folder are set before importing anything that
// touches the db package -- `@opencroft/db` opens the connection and migrates at
// import time, so the environment has to be in place first. A datadir of its own
// also gives the suite the state it is about: a workspace that starts empty,
// which a datadir shared with every other suite never is.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

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

const { createSpaceImpl, deleteSpaceImpl, registry, setSpaceIconImpl } = await import('./actions-impl')
const { findSpaceIconPreset } = await import('ui/spaces/space-icon')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

test('a fresh workspace starts with no spaces', async () => {
  const r = await registry()
  assert.deepEqual(r.list(), [])
})

test('the last remaining space can be deleted', async () => {
  const r = await registry()
  const first = await createSpaceImpl('Workshop')
  const second = await createSpaceImpl('Field Notes')
  assert.deepEqual(
    r.list().map((s) => s.slug),
    [first.slug, second.slug],
  )

  assert.equal(await deleteSpaceImpl(first.slug), true)
  assert.equal(await deleteSpaceImpl(second.slug), true)
  assert.deepEqual(r.list(), [])
})

test('deleting a slug that names no space reports false', async () => {
  assert.equal(await deleteSpaceImpl('no-such-space'), false)
})

test('a new space wears a preset icon', async () => {
  const created = await createSpaceImpl('Icon Test')
  assert.ok(findSpaceIconPreset(created.icon), `${created.icon} is not a known preset`)
  await deleteSpaceImpl(created.slug)
})

test('an icon is a known preset or a small image, and nothing else', async () => {
  const { slug } = await createSpaceImpl('Icon Rules')

  const preset = await setSpaceIconImpl({ slug, icon: 'preset:telescope:violet' })
  assert.equal(preset?.icon, 'preset:telescope:violet')
  const image = await setSpaceIconImpl({ slug, icon: 'data:image/png;base64,AAAA' })
  assert.equal(image?.icon, 'data:image/png;base64,AAAA')

  for (const icon of [null, 'preset:telescope:mauve', 'preset:unknown:blue', 'data:image/gif;base64,AAAA']) {
    await assert.rejects(() => setSpaceIconImpl({ slug, icon: icon as string }), `${icon} was accepted`)
  }
  const [stored] = (await registry()).list().filter((space) => space.slug === slug)
  assert.equal(stored.icon, 'data:image/png;base64,AAAA', 'a refused icon left the stored one alone')
  await deleteSpaceImpl(slug)
})
