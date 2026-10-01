// Which extension folders exist and which id each one runs under, read from a
// real extensions root in a scratch data dir. The database is the one the suite
// shares with others, so every folder and row here carries a suffix of its
// own and is removed afterwards.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { db, extension } from '@opencroft/db'
import { eq, inArray } from 'drizzle-orm'

import {
  type ExtensionFolder,
  extensionIdOf,
  listAllExtensionIds,
  MANIFEST_FILE,
  scanExtensionFolders,
} from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import { extDir, folderOf } from '@/app/_authed/(extension-runtime)/_server/paths'

const suffix = crypto.randomUUID().slice(0, 8)

/** A data dir of its own for one test, with the environment put back afterwards. */
async function withDataDir(
  run: (extensionsRoot: string) => Promise<void>,
  { rows = [] }: { rows?: string[] } = {},
): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-folders-'))
  const savedDataDir = process.env.OPENCROFT_DATA_DIR
  process.env.OPENCROFT_DATA_DIR = scratch
  try {
    await run(path.join(scratch, 'extensions'))
  } finally {
    if (savedDataDir === undefined) {
      delete process.env.OPENCROFT_DATA_DIR
    } else {
      process.env.OPENCROFT_DATA_DIR = savedDataDir
    }
    if (rows.length > 0) {
      await db.delete(extension).where(inArray(extension.folder, rows))
    }
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

/** A folder under the root; `manifest` undefined leaves it without one. */
async function writeFolder(extensionsRoot: string, name: string, manifest?: unknown): Promise<void> {
  const dir = path.join(extensionsRoot, name)
  await fs.mkdir(dir, { recursive: true })
  if (manifest !== undefined) {
    await fs.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest))
  }
}

function entryOf(entries: ExtensionFolder[], folder: string): ExtensionFolder {
  const found = entries.find((entry) => entry.folder === folder)
  assert.ok(found, `${folder} must be listed; got ${entries.map((entry) => entry.folder).join(', ')}`)
  return found
}

test('only a local folder takes its id from its manifest', () => {
  // A fetched repository does not get to name itself: its manifest is not even
  // read for an id, so a claim that would be invalid changes nothing either.
  assert.deepEqual(extensionIdOf('acme.widgets', 'other.thing'), { extensionId: 'acme.widgets' })
  assert.deepEqual(extensionIdOf('acme.widgets', 'not an id'), { extensionId: 'acme.widgets' })
  assert.deepEqual(extensionIdOf('local.widgets', 'acme.widgets'), { extensionId: 'acme.widgets' })
  assert.deepEqual(extensionIdOf('local.widgets', undefined), { extensionId: 'local.widgets' })
  assert.deepEqual(extensionIdOf('local.widgets', ''), { extensionId: 'local.widgets' })
  assert.ok('error' in extensionIdOf('local.widgets', 'builtin.core'))
  assert.ok('error' in extensionIdOf('local.widgets', 'acme'))
})

test('a folder that is not local runs under its own name, whatever its manifest says', async () => {
  const folder = `acme.widgets-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, folder, { id: `other.thing-${suffix}`, name: 'Widgets' })

    const entries = await scanExtensionFolders()

    assert.deepEqual(entryOf(entries, folder), { folder, extensionId: folder, active: true })
    assert.equal(
      entries.some((entry) => entry.extensionId === `other.thing-${suffix}`),
      false,
    )
    assert.ok((await listAllExtensionIds()).includes(folder))
    assert.equal(extDir(folder), path.join(root, folder))
  })
})

test('a local folder runs under the id its manifest claims, and wins over the folder of that id', async () => {
  const claimed = `acme.widgets-${suffix}`
  const local = `local.widgets-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, claimed, { name: 'Widgets' })
    await writeFolder(root, local, { id: claimed, name: 'Widgets (development copy)' })

    const entries = await scanExtensionFolders()

    assert.deepEqual(entryOf(entries, local), { folder: local, extensionId: claimed, active: true })
    // Listed, not hidden: it stays on disk and says why it is not being served.
    assert.deepEqual(entryOf(entries, claimed), {
      folder: claimed,
      extensionId: claimed,
      active: false,
      error: `${claimed} is served by ${local}`,
    })
    assert.equal(folderOf(claimed), local)
    assert.equal(extDir(claimed), path.join(root, local))
    assert.equal(
      (await listAllExtensionIds()).filter((id) => id === claimed).length,
      1,
      'the id is served once, not once per folder claiming it',
    )
  })
})

test('the folder of the id comes back into effect when the local copy is gone', async () => {
  const claimed = `acme.widgets-${suffix}`
  const local = `local.widgets-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, claimed, { name: 'Widgets' })
    await writeFolder(root, local, { id: claimed, name: 'Widgets (development copy)' })
    await scanExtensionFolders()
    assert.equal(extDir(claimed), path.join(root, local), 'control: the local copy is serving before it goes')

    await fs.rm(path.join(root, local), { recursive: true, force: true })
    const entries = await scanExtensionFolders()

    assert.deepEqual(entryOf(entries, claimed), { folder: claimed, extensionId: claimed, active: true })
    assert.equal(extDir(claimed), path.join(root, claimed))
  })
})

test('a local folder whose manifest claims no id runs under its folder name', async () => {
  const folder = `local.notes-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, folder, { name: 'Notes' })

    const entries = await scanExtensionFolders()

    assert.deepEqual(entryOf(entries, folder), { folder, extensionId: folder, active: true })
    assert.equal(extDir(folder), path.join(root, folder))
  })
})

test('a local manifest id that is not two slugs makes the folder inactive, with the reason', async () => {
  const claims = ['Not An Id', 'acme.widgets.gauge', 'acme', 'acme/widgets', 42]
  await withDataDir(async (root) => {
    const folders = claims.map((_, index) => `local.bad-${index}-${suffix}`)
    for (const [index, claim] of claims.entries()) {
      await writeFolder(root, folders[index], { id: claim, name: 'Bad' })
    }

    const entries = await scanExtensionFolders()

    for (const [index, folder] of folders.entries()) {
      const entry = entryOf(entries, folder)
      assert.equal(entry.active, false, `${JSON.stringify(claims[index])} must not run`)
      assert.equal(entry.extensionId, null)
      assert.match(entry.error ?? '', /is not an extension id/)
    }
  })
})

test('a local manifest that names a builtin is refused, and the builtin is left alone', async () => {
  const folder = `local.impostor-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, folder, { id: 'builtin.core', name: 'Impostor' })

    const entries = await scanExtensionFolders()

    const entry = entryOf(entries, folder)
    assert.equal(entry.active, false)
    assert.equal(entry.extensionId, null)
    assert.match(entry.error ?? '', /names a builtin extension/)
    assert.equal(entryOf(entries, 'builtin.core').active, true, 'the builtin still serves its own id')
    assert.equal(folderOf('builtin.core'), 'builtin.core')
  })
})

test('a local folder with an unreadable manifest is listed inactive rather than dropped', async () => {
  const folder = `local.broken-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, folder)
    await fs.writeFile(path.join(root, folder, MANIFEST_FILE), '{ not json')

    const entry = entryOf(await scanExtensionFolders(), folder)

    assert.equal(entry.active, false)
    assert.equal(entry.extensionId, null)
    assert.match(entry.error ?? '', new RegExp(`cannot read ${MANIFEST_FILE}`))
  })
})

test('of two local folders claiming one id, the one that appeared first wins', async () => {
  const claimed = `acme.gauge-${suffix}`
  // Alphabetically `a` comes before `z`, so a winner picked by name would be the
  // one that is not the older row in the first run below.
  const a = `local.a-gauge-${suffix}`
  const z = `local.z-gauge-${suffix}`
  await withDataDir(
    async (root) => {
      await writeFolder(root, a, { id: claimed, name: 'A' })
      await writeFolder(root, z, { id: claimed, name: 'Z' })

      await db.insert(extension).values([
        { folder: a, createdAt: new Date('2021-01-01T00:00:00Z') },
        { folder: z, createdAt: new Date('2020-01-01T00:00:00Z') },
      ])
      let entries = await scanExtensionFolders()
      assert.equal(entryOf(entries, z).active, true, 'the older row wins')
      assert.deepEqual(entryOf(entries, a), {
        folder: a,
        extensionId: claimed,
        active: false,
        error: `${claimed} is served by ${z}`,
      })
      assert.equal(extDir(claimed), path.join(root, z))

      // The same two folders with the dates swapped: the winner follows the date.
      await db
        .update(extension)
        .set({ createdAt: new Date('2019-01-01T00:00:00Z') })
        .where(eq(extension.folder, a))
      entries = await scanExtensionFolders()
      assert.equal(entryOf(entries, a).active, true)
      assert.equal(entryOf(entries, z).active, false)
      assert.equal(extDir(claimed), path.join(root, a))
    },
    { rows: [a, z] },
  )
})

test('a folder with no row counts as appearing now, so it never outranks one that has a row', async () => {
  const claimed = `acme.gauge-${suffix}`
  const withRow = `local.zz-gauge-${suffix}`
  const withoutRow = `local.aa-gauge-${suffix}`
  await withDataDir(
    async (root) => {
      await writeFolder(root, withRow, { id: claimed, name: 'Has a row' })
      await writeFolder(root, withoutRow, { id: claimed, name: 'Copied in by hand' })
      await db.insert(extension).values({ folder: withRow, createdAt: new Date('2020-01-01T00:00:00Z') })

      const entries = await scanExtensionFolders()

      assert.equal(entryOf(entries, withRow).active, true)
      assert.equal(entryOf(entries, withoutRow).active, false)
      assert.equal(extDir(claimed), path.join(root, withRow))
    },
    { rows: [withRow, withoutRow] },
  )
})

test('staging and backup folders, and a builtin folder under the root, are never listed as extensions', async () => {
  const real = `acme.real-${suffix}`
  await withDataDir(async (root) => {
    await writeFolder(root, real, { name: 'Real' })
    // Each of these holds a manifest, so only their names keep them out.
    await writeFolder(root, `.staging-${real}-1-1`, { name: 'Half installed' })
    await writeFolder(root, `.old-${real}-1-1`, { name: 'Displaced' })
    await writeFolder(root, `builtin.fake-${suffix}`, { name: 'Build output of a builtin' })

    const entries = await scanExtensionFolders()
    const folders = entries.map((entry) => entry.folder)

    assert.ok(folders.includes(real), 'control: a real extension beside them is listed')
    assert.ok(folders.includes('builtin.core'), 'control: builtins are listed from the app tree')
    assert.deepEqual(
      folders.filter((folder) => folder.startsWith('.') || folder === `builtin.fake-${suffix}`),
      [],
    )
    assert.equal((await listAllExtensionIds()).includes(`builtin.fake-${suffix}`), false)
  })
})
