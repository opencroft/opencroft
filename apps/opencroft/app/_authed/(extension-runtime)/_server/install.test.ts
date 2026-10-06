// Installing, updating, removing and recovering extension folders, against a
// real local git repository as the source and a real build. The extension the
// repository holds is a manifest and a one-line server module with no
// package.json, so the build needs no npm and finishes in well under a second.
//
// Each test has a data dir of its own, so the extensions root it inspects holds
// only what that test put there. The database is the one the suite shares, so
// every folder carries a suffix of its own and its row is removed afterwards.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { db, extension } from '@opencroft/db'
import { inArray } from 'drizzle-orm'

import { getExtensionRow, writeExtensionRow } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import {
  checkForUpdates,
  folderForUrl,
  installExtension,
  sweepInstallDebris,
  uninstallExtension,
  updateExtension,
} from '@/app/_authed/(extension-runtime)/_server/install'

const execFileAsync = promisify(execFile)

const suffix = crypto.randomUUID().slice(0, 8)
const hasGit = spawnSync('git', ['--version']).status === 0
const NO_GIT = 'git is not installed on this machine, and these tests install from a real local repository'
const gitTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasGit ? false : NO_GIT }, fn)

// ── fixtures ─────────────────────────────────────────────────────────

interface Scratch {
  /** Where sources are built: outside the extensions root, which must hold only installs. */
  sources: string
  extensionsRoot: string
}

/** A data dir of its own for one test, with the environment and the rows put back afterwards. */
async function withScratch(folders: string[], run: (scratch: Scratch) => Promise<void>): Promise<void> {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-install-'))
  const savedDataDir = process.env.OPENCROFT_DATA_DIR
  process.env.OPENCROFT_DATA_DIR = data
  try {
    await run({ sources: path.join(data, 'sources'), extensionsRoot: path.join(data, 'extensions') })
  } finally {
    if (savedDataDir === undefined) {
      delete process.env.OPENCROFT_DATA_DIR
    } else {
      process.env.OPENCROFT_DATA_DIR = savedDataDir
    }
    if (folders.length > 0) {
      await db.delete(extension).where(inArray(extension.folder, folders))
    }
    await fs.rm(data, { recursive: true, force: true })
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  // An identity and no signing on the command line, so no global git config
  // decides whether a commit can be made.
  const identity = ['-c', 'commit.gpgsign=false', '-c', 'user.name=a', '-c', 'user.email=a@example.com']
  const { stdout } = await execFileAsync('git', [...identity, ...args], { cwd })
  return stdout.trim()
}

async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    if (content === null) {
      await fs.rm(target, { force: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
}

const VALID_SERVER = 'export const actions = {}\n'
const BROKEN_SERVER = 'export const actions = {\n'

function manifestOf(version: string): string {
  return JSON.stringify({ name: 'Widgets', version })
}

/** A repository holding one extension at `version`, tagged `v<version>`; returns its URL. */
async function makeSource(sources: string, name: string, version = '1.0.0'): Promise<{ dir: string; url: string }> {
  const dir = path.join(sources, name)
  await fs.mkdir(dir, { recursive: true })
  await git(dir, 'init', '-q')
  // Pinned rather than inherited: the default branch name is a git setting.
  await git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await writeFiles(dir, { 'extension.json': manifestOf(version), 'server/index.ts': VALID_SERVER, 'old-only.txt': 'x' })
  await commitAs(dir, version)
  return { dir, url: `file://${dir}` }
}

/** Commit the working tree and tag it `v<version>`; returns the full sha. */
async function commitAs(dir: string, version: string): Promise<string> {
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', `release ${version}`)
  await git(dir, 'tag', `v${version}`)
  return git(dir, 'rev-parse', 'HEAD')
}

async function entriesOf(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort()
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  )
}

// ── install ──────────────────────────────────────────────────────────

gitTest('a fresh install lands in its folder as a source snapshot, with its row and no debris', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')
    const head = await git(source.dir, 'rev-parse', 'HEAD')

    const row = await installExtension({ folder, url: source.url, asLocal: false })

    const dir = path.join(extensionsRoot, folder)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')), {
      name: 'Widgets',
      version: '1.0.0',
    })
    assert.equal(await exists(path.join(dir, '.git')), false, 'a snapshot carries no .git')
    assert.ok(await exists(path.join(dir, 'dist', 'server.js')), 'it is built where it lands')
    assert.equal(row.commit, head)
    assert.match(row.commit ?? '', /^[0-9a-f]{40}$/, 'the full sha, not an abbreviation')
    assert.equal(row.ref, 'v1.0.0', 'the highest version tag is what is installed')
    assert.equal(row.sourceUrl, source.url)
    assert.deepEqual(await getExtensionRow(folder), row, 'and the row is what was written')
    assert.deepEqual(await entriesOf(extensionsRoot), [folder], 'no staging or displaced folder is left')
  })
})

gitTest('a second install into the same folder is refused, naming where the first came from', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const first = await makeSource(sources, 'first')
    const second = await makeSource(sources, 'second', '2.0.0')
    await installExtension({ folder, url: first.url, asLocal: false })

    await assert.rejects(installExtension({ folder, url: second.url, asLocal: false }), (error: Error) => {
      assert.match(error.message, /is already installed/)
      assert.ok(error.message.includes(first.url), error.message)
      return true
    })

    const manifest = JSON.parse(await fs.readFile(path.join(extensionsRoot, folder, 'extension.json'), 'utf-8'))
    assert.equal(manifest.version, '1.0.0', 'the installed one was not overwritten')
    assert.equal((await getExtensionRow(folder))?.sourceUrl, first.url)
    assert.deepEqual(await entriesOf(extensionsRoot), [folder])
  })
})

gitTest('an update replaces the folder with a fresh fetch and keeps when the extension first appeared', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')
    const installed = await installExtension({ folder, url: source.url, asLocal: false })
    // The next release drops one file and adds another.
    await writeFiles(source.dir, { 'extension.json': manifestOf('1.1.0'), 'old-only.txt': null, 'new-only.txt': 'y' })
    const newHead = await commitAs(source.dir, '1.1.0')

    const updated = await updateExtension(folder)

    const dir = path.join(extensionsRoot, folder)
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')).version, '1.1.0')
    assert.equal(await exists(path.join(dir, 'old-only.txt')), false, 'a file the release dropped is gone')
    assert.equal(await exists(path.join(dir, 'new-only.txt')), true)
    assert.equal(updated.commit, newHead)
    assert.equal(updated.ref, 'v1.1.0')
    assert.equal(updated.createdAt.getTime(), installed.createdAt.getTime(), 'an update is not a new arrival')
    assert.ok(updated.updatedAt.getTime() >= installed.updatedAt.getTime())
    assert.deepEqual(await entriesOf(extensionsRoot), [folder], 'the displaced folder is deleted')
  })
})

gitTest('an update whose build fails leaves the live folder and its row as they were', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')
    await installExtension({ folder, url: source.url, asLocal: false })
    const rowBefore = await getExtensionRow(folder)
    const dir = path.join(extensionsRoot, folder)
    const manifestBefore = await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')
    const bundleBefore = await fs.readFile(path.join(dir, 'dist', 'server.js'), 'utf-8')
    await writeFiles(source.dir, { 'extension.json': manifestOf('1.1.0'), 'server/index.ts': BROKEN_SERVER })
    await commitAs(source.dir, '1.1.0')

    await assert.rejects(updateExtension(folder), /did not build/)

    assert.equal(await fs.readFile(path.join(dir, 'extension.json'), 'utf-8'), manifestBefore)
    assert.equal(await fs.readFile(path.join(dir, 'dist', 'server.js'), 'utf-8'), bundleBefore)
    assert.deepEqual(await getExtensionRow(folder), rowBefore)
    assert.deepEqual(await entriesOf(extensionsRoot), [folder], 'the half-built staging folder is removed')
  })
})

gitTest('a fresh install whose build fails leaves neither a folder nor a row', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')
    await writeFiles(source.dir, { 'server/index.ts': BROKEN_SERVER })
    await commitAs(source.dir, '1.0.1')

    await assert.rejects(installExtension({ folder, url: source.url, asLocal: false }), /did not build/)

    assert.deepEqual(await entriesOf(extensionsRoot), [])
    assert.equal(await getExtensionRow(folder), null)
  })
})

gitTest('a development checkout keeps its .git and goes into a local folder', async () => {
  const folder = `local.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')
    const head = await git(source.dir, 'rev-parse', 'HEAD')

    const row = await installExtension({ folder, url: source.url, asLocal: true })

    const dir = path.join(extensionsRoot, folder)
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), head, 'a checkout of the repository, history included')
    assert.equal(row.commit, head)
    assert.equal(row.ref, 'main', 'the default branch, not a version tag')
    assert.ok(await exists(path.join(dir, 'dist', 'server.js')))
    assert.deepEqual(await entriesOf(extensionsRoot), [folder])
  })
})

gitTest('a development checkout cannot go into an owner folder, nor a snapshot into a local one', async () => {
  await withScratch([], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')

    await assert.rejects(
      installExtension({ folder: `acme.widgets-${suffix}`, url: source.url, asLocal: true }),
      /local\.<name> folder/,
    )
    await assert.rejects(
      installExtension({ folder: `local.widgets-${suffix}`, url: source.url, asLocal: false }),
      /not an installable extension id/,
    )
    await assert.rejects(fs.readdir(extensionsRoot), 'nothing was created for either')
  })
})

// ── update ───────────────────────────────────────────────────────────

test('an update of a folder with no recorded source has nothing to update it from', async () => {
  const folder = `local.hand-made-${suffix}`
  await withScratch([folder], async () => {
    await writeExtensionRow(folder, null)
    await assert.rejects(updateExtension(folder), /nothing to update it from/)
  })
})

gitTest('an install at a tag is offered the newest tag, and nothing once it is there', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources }) => {
    const source = await makeSource(sources, 'widgets')
    const installed = await installExtension({ folder, url: source.url, asLocal: false })
    assert.deepEqual(await checkForUpdates(folder), {
      current: 'v1.0.0',
      currentCommit: installed.commit,
      latest: 'v1.0.0',
      latestCommit: null,
      followsBranch: false,
      hasUpdate: false,
      availableTags: ['v1.0.0'],
    })

    await writeFiles(source.dir, { 'extension.json': manifestOf('1.1.0') })
    await commitAs(source.dir, '1.1.0')

    assert.deepEqual(await checkForUpdates(folder), {
      current: 'v1.0.0',
      currentCommit: installed.commit,
      latest: 'v1.1.0',
      latestCommit: null,
      followsBranch: false,
      hasUpdate: true,
      availableTags: ['v1.1.0', 'v1.0.0'],
    })
  })
})

gitTest('an install following a branch is offered its new commits, not the newest tag', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources }) => {
    // The repository has a tag, and the install chose the branch anyway.
    const source = await makeSource(sources, 'widgets')
    const installed = await installExtension({ folder, url: source.url, ref: 'main', asLocal: false })
    const atInstall = await checkForUpdates(folder)
    assert.equal(atInstall.followsBranch, true)
    assert.equal(atInstall.hasUpdate, false, 'the tag the repository also has is not an update to a branch install')

    // A commit on the branch, with no tag of its own.
    await writeFiles(source.dir, { 'extension.json': manifestOf('1.0.1') })
    await git(source.dir, 'add', '-A')
    await git(source.dir, 'commit', '-q', '-m', 'unreleased')
    const tip = await git(source.dir, 'rev-parse', 'HEAD')

    assert.deepEqual(await checkForUpdates(folder), {
      current: 'main',
      currentCommit: installed.commit,
      latest: 'main',
      latestCommit: tip,
      followsBranch: true,
      hasUpdate: true,
      availableTags: ['v1.0.0'],
    })

    const updated = await updateExtension(folder)
    assert.equal(updated.ref, 'main', 'an update with no ref stays on the branch')
    assert.equal(updated.commit, tip)
    assert.equal((await checkForUpdates(folder)).hasUpdate, false)
  })
})

// ── uninstall ────────────────────────────────────────────────────────

gitTest('an uninstall removes the folder, then the row', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ sources, extensionsRoot }) => {
    const source = await makeSource(sources, 'widgets')
    await installExtension({ folder, url: source.url, asLocal: false })

    await uninstallExtension(folder)

    assert.deepEqual(await entriesOf(extensionsRoot), [])
    assert.equal(await getExtensionRow(folder), null)
  })
})

test('an uninstall of a recorded install whose folder is already gone succeeds and removes the row', async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async () => {
    await writeExtensionRow(folder, { url: 'file:///nowhere', ref: 'v1.0.0', commit: 'a'.repeat(40) })
    assert.ok(await getExtensionRow(folder), 'control: the row is there before')

    await uninstallExtension(folder)

    assert.equal(await getExtensionRow(folder), null)
  })
})

const ROOT_SKIP = process.getuid?.() === 0 ? 'running as root, where directory permissions are not enforced' : false

test('an uninstall that cannot remove the folder fails and keeps the row', { skip: ROOT_SKIP }, async () => {
  const folder = `acme.widgets-${suffix}`
  await withScratch([folder], async ({ extensionsRoot }) => {
    await fs.mkdir(path.join(extensionsRoot, folder), { recursive: true })
    await fs.writeFile(path.join(extensionsRoot, folder, 'extension.json'), manifestOf('1.0.0'))
    await writeExtensionRow(folder, { url: 'file:///nowhere', ref: 'v1.0.0', commit: 'a'.repeat(40) })
    // A directory that cannot be modified cannot lose an entry.
    await fs.chmod(extensionsRoot, 0o500)
    try {
      await assert.rejects(uninstallExtension(folder))
      assert.ok(
        await getExtensionRow(folder),
        'the row stays while the folder may still be on disk, so it can be retried',
      )
      assert.ok(await exists(path.join(extensionsRoot, folder)))
    } finally {
      await fs.chmod(extensionsRoot, 0o700)
    }
  })
})

test('a builtin cannot be uninstalled', async () => {
  await assert.rejects(uninstallExtension('builtin.core'), /cannot be removed/)
})

// ── crash recovery ───────────────────────────────────────────────────

test('the startup sweep deletes staging folders and puts displaced ones back or deletes them', async () => {
  const missing = `acme.missing-${suffix}`
  const present = `acme.present-${suffix}`
  await withScratch([], async ({ extensionsRoot }) => {
    await fs.mkdir(path.join(extensionsRoot, `.staging-${missing}-1-1`), { recursive: true })
    // Killed between the two renames: the live folder is missing.
    await fs.mkdir(path.join(extensionsRoot, `.old-${missing}-1-1`), { recursive: true })
    await fs.writeFile(path.join(extensionsRoot, `.old-${missing}-1-1`, 'extension.json'), manifestOf('1.0.0'))
    // Killed after both renames, before the displaced folder was deleted.
    await fs.mkdir(path.join(extensionsRoot, present), { recursive: true })
    await fs.writeFile(path.join(extensionsRoot, present, 'extension.json'), manifestOf('2.0.0'))
    await fs.mkdir(path.join(extensionsRoot, `.old-${present}-1-1`), { recursive: true })
    await fs.writeFile(path.join(extensionsRoot, `.old-${present}-1-1`, 'extension.json'), manifestOf('1.0.0'))

    await sweepInstallDebris()

    assert.deepEqual(await entriesOf(extensionsRoot), [missing, present].sort())
    assert.equal(
      JSON.parse(await fs.readFile(path.join(extensionsRoot, missing, 'extension.json'), 'utf-8')).version,
      '1.0.0',
      'the displaced folder is back where it was',
    )
    assert.equal(
      JSON.parse(await fs.readFile(path.join(extensionsRoot, present, 'extension.json'), 'utf-8')).version,
      '2.0.0',
      'the live folder is not replaced by the displaced one',
    )
  })
})

test('the startup sweep of an instance with no extensions root does nothing', async () => {
  await withScratch([], async ({ extensionsRoot }) => {
    await sweepInstallDebris()
    assert.equal(await exists(extensionsRoot), false, 'and creates nothing')
  })
})

// ── which folder a URL installs into ─────────────────────────────────

test('a URL install goes into <owner>.<repo>, each part made a slug on its own', () => {
  assert.equal(folderForUrl('https://host.example/Acme/My.Repo'), 'acme.my-repo')
  assert.equal(folderForUrl('https://host.example/acme/widgets.git'), 'acme.widgets')
  assert.equal(folderForUrl('acme/widgets'), 'acme.widgets')
  assert.equal(
    folderForUrl('https://host.example/acme/foo.bar'),
    folderForUrl('https://host.example/acme/foo-bar'),
    'two sources can meet on one folder, which the install then refuses rather than suffixes',
  )
})

test('a URL whose path is not owner/repo needs an explicit id, which is used as given', () => {
  const nested = 'https://host.example/group/subgroup/repo'
  assert.throws(() => folderForUrl(nested), /give the extension id/)
  assert.equal(folderForUrl(nested, { id: 'acme.widgets' }), 'acme.widgets')
  assert.equal(folderForUrl('https://host.example/acme/widgets', { id: 'other.name' }), 'other.name')
})

test('an explicit id must be two slugs and cannot take a reserved owner', () => {
  for (const id of ['local.widgets', 'builtin.widgets', 'Acme.widgets', 'acme', 'acme.widgets.gauge']) {
    assert.throws(
      () => folderForUrl('https://host.example/acme/widgets', { id }),
      /not an installable extension id/,
      id,
    )
  }
})

test('a development checkout is named local.<repo>, whatever the path above the repo', () => {
  assert.equal(folderForUrl('https://host.example/Acme/My.Repo', { asLocal: true }), 'local.my-repo')
  assert.equal(folderForUrl('https://host.example/group/subgroup/repo', { asLocal: true }), 'local.repo')
})
