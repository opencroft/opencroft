// The legacy dashboard's cache folders against a cache directory of the test's
// own: they are deleted with what they hold, and every other folder stays.

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { removeLegacyCacheFolders } from '@/server/legacy-cache-removal'

const cache = await mkdtemp(join(tmpdir(), 'legacy-cache-removal-'))
process.env.OPENCROFT_CACHE_DIR = cache

after(() => rm(cache, { recursive: true, force: true }))

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

test('deletes the legacy folders and keeps the Key Store and extension caches', async () => {
  await mkdir(join(cache, 'ssh-keys', 'store-1'), { recursive: true })
  await writeFile(join(cache, 'ssh-keys', 'store-1', 'deploy'), 'private key')
  await mkdir(join(cache, 'ssh-config'), { recursive: true })
  await writeFile(join(cache, 'ssh-config', 'config'), 'Host example')
  await mkdir(join(cache, 'apps', 'app-1'), { recursive: true })
  await writeFile(join(cache, 'apps', 'app-1', 'index.html'), '<html></html>')
  await mkdir(join(cache, 'key-store', 'store-2'), { recursive: true })
  await writeFile(join(cache, 'key-store', 'store-2', 'deploy'), 'kept key')
  await mkdir(join(cache, 'extensions', 'ext-1'), { recursive: true })
  await writeFile(join(cache, 'extensions', 'ext-1', 'data'), 'kept data')

  assert.deepEqual(await removeLegacyCacheFolders(), ['ssh-keys', 'ssh-config', 'apps'])

  for (const folder of ['ssh-keys', 'ssh-config', 'apps']) {
    assert.equal(await exists(join(cache, folder)), false, `${folder} is deleted`)
  }
  assert.equal(await readFile(join(cache, 'key-store', 'store-2', 'deploy'), 'utf-8'), 'kept key')
  assert.equal(await readFile(join(cache, 'extensions', 'ext-1', 'data'), 'utf-8'), 'kept data')
})

test('answers no folders when none of them is there', async () => {
  assert.deepEqual(await removeLegacyCacheFolders(), [])
})
