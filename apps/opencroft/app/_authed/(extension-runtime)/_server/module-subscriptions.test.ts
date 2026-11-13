// A subscription an extension's server module makes at module level and never
// removes ends when the loader unloads that evaluation. Exercised through the
// real build, evaluation and reactivation of a scratch fixture extension, and
// counted by what its listener hears, not by reading the listener sets.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { announceDirectoryChange } from '@/app/_authed/(space)/_server/directory-changes'
import { flushCache, getExtensionModule } from './loader'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-module-subscriptions-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0

/**
 * An extension whose server module subscribes to the spaces directory at
 * module level, has no `unload`, and appends a line to `logFile` for every
 * change it hears. With `ownUnload`, it also exports an `unload` that
 * unsubscribes, to show the host's ending does not trip over it.
 */
async function makeFixture(options: { ownUnload?: boolean } = {}): Promise<{
  id: string
  dir: string
  logFile: string
}> {
  seq += 1
  const id = `local.module-subscriptions-${seq}`
  const dir = path.join(root, 'extensions', id)
  const logFile = path.join(root, `${id}-heard.txt`)
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'server', 'index.ts'),
    `import { promises as fs } from 'node:fs'
import { spaces } from '@opencroft/server/spaces'
const unsubscribe = spaces.subscribe(() => fs.appendFile(${JSON.stringify(logFile)}, 'heard\\n'))
export const actions = {}
${options.ownUnload ? 'export function unload() { unsubscribe() }\n' : ''}`,
  )
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  // Dated an hour back, as activation-race.test.ts does and for its reason: a
  // cached module is fresh while its sources are no newer than its activation.
  await dateSources(dir, Date.now() - 60 * 60 * 1000)
  return { id, dir, logFile }
}

async function dateSources(dir: string, at: number): Promise<void> {
  const when = new Date(at)
  for (const entry of ['server/index.ts', 'server', 'extension.json']) {
    await fs.utimes(path.join(dir, entry), when, when)
  }
}

/** Every line the fixture's listener wrote, once `expected` of them have arrived or two seconds have passed. */
async function heard(logFile: string, expected: number): Promise<number> {
  const deadline = Date.now() + 2000
  let count = 0
  do {
    const text = await fs.readFile(logFile, 'utf-8').catch(() => '')
    count = text.split('\n').filter(Boolean).length
    if (count >= expected) {
      // Past the expected count, give a listener left over from an earlier
      // evaluation the same chance to write before the count is final.
      await new Promise((resolve) => setTimeout(resolve, 100))
      return (await fs.readFile(logFile, 'utf-8')).split('\n').filter(Boolean).length
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  return count
}

/** Recompile: sources newer than the cached activation make the next call reactivate. */
async function recompile(id: string, dir: string, round: number): Promise<void> {
  const before = await getExtensionModule(id)
  await dateSources(dir, Date.now() + round * 60 * 1000)
  const afterRecompile = await getExtensionModule(id)
  assert.notEqual(afterRecompile, before, 'the newer sources reactivated the module')
}

test('a module-level subscription the module never removes is ended by each recompile', async () => {
  const { id, dir, logFile } = await makeFixture()
  for (let round = 1; round <= 3; round += 1) {
    await recompile(id, dir, round)
  }

  announceDirectoryChange({ subject: 'space', change: 'added' })
  assert.equal(await heard(logFile, 1), 1, 'one evaluation stands, so one listener hears the change')
})

test('flushing the module ends its subscriptions too', async () => {
  const { id, logFile } = await makeFixture()
  await getExtensionModule(id)
  flushCache(id)

  announceDirectoryChange({ subject: 'space', change: 'added' })
  assert.equal(await heard(logFile, 1), 0, 'nothing of the flushed module hears a change')

  // Control: the reactivated module subscribes afresh and hears the next one.
  await getExtensionModule(id)
  announceDirectoryChange({ subject: 'space', change: 'added' })
  assert.equal(await heard(logFile, 1), 1)
})

test("an extension's own unload unsubscribing first leaves the host nothing to end, and nothing fails", async () => {
  const { id, dir, logFile } = await makeFixture({ ownUnload: true })
  await recompile(id, dir, 1)

  announceDirectoryChange({ subject: 'space', change: 'added' })
  assert.equal(await heard(logFile, 1), 1)
})
