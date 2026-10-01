// The manifest listing starts the lifecycle extensions' activation but does not
// wait for it: what it returns is read from disk, and a caller that needs the
// module joins the activation through getExtensionModule. Real build and
// activation against a scratch fixture, as in activation-race.test.ts.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { listExtensionManifestsImpl } from './extension-action-impl'
import { getExtensionModule } from './loader'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-listing-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root
const releaseFile = path.join(root, 'release')

after(async () => {
  // Lets a still-blocked load() finish, so nothing keeps the process alive.
  await fs.writeFile(releaseFile, '')
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

// A lifecycle extension whose load() records that it started and then blocks
// until the test creates `releaseFile`.
async function makeLifecycleFixture(): Promise<{ id: string; logFile: string }> {
  const id = 'local.lifecycle-sample'
  const dir = path.join(root, 'extensions', id)
  const logFile = path.join(root, 'load-log.txt')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'extension.ts'),
    `import { existsSync, promises as fs } from 'node:fs'
export async function load() {
  await fs.appendFile(${JSON.stringify(logFile)}, 'started\\n')
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(${JSON.stringify(releaseFile)})) {
        clearInterval(timer)
        resolve(undefined)
      }
    }, 10)
  })
  await fs.appendFile(${JSON.stringify(logFile)}, 'finished\\n')
}
export const actions = {}
`,
  )
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  return { id, logFile }
}

async function logLines(logFile: string): Promise<string[]> {
  const text = await fs.readFile(logFile, 'utf-8').catch(() => '')
  return text.split('\n').filter(Boolean)
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('the listing answers while a lifecycle extension is still loading, and a later module request joins that load', {
  timeout: 120_000,
}, async () => {
  const { id, logFile } = await makeLifecycleFixture()

  const manifests = await listExtensionManifestsImpl()

  assert.ok(
    manifests.some((manifest) => manifest.id === id),
    'the lifecycle extension is listed',
  )
  assert.ok(!(await logLines(logFile)).includes('finished'), 'the listing did not wait for load() to finish')
  await waitFor(async () => (await logLines(logFile)).includes('started'), 'the listing to start the activation')

  await fs.writeFile(releaseFile, '')
  await getExtensionModule(id)

  assert.deepEqual(await logLines(logFile), ['started', 'finished'], 'one activation, joined rather than repeated')
})
