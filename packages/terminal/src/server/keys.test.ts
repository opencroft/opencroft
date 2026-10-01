import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveKeyContent } from './keys'

/** A cache directory of its own, with OPENCROFT_CACHE_DIR put back exactly afterwards. */
async function withCacheDir(run: (extensionsCache: string) => Promise<void>): Promise<void> {
  const cache = await mkdtemp(join(tmpdir(), 'terminal-keys-'))
  const saved = process.env.OPENCROFT_CACHE_DIR
  process.env.OPENCROFT_CACHE_DIR = cache
  try {
    await run(join(cache, 'extensions'))
  } finally {
    if (saved === undefined) {
      delete process.env.OPENCROFT_CACHE_DIR
    } else {
      process.env.OPENCROFT_CACHE_DIR = saved
    }
    await rm(cache, { recursive: true, force: true })
  }
}

async function plantKey(extensionsCache: string, extensionId: string, storeId: string, name: string, content: string) {
  const dir = join(extensionsCache, extensionId, 'key-store', storeId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), content)
}

test('a store key is read from <cache>/extensions/<extensionId>/key-store, one directory below extensions', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    assert.equal(await resolveKeyContent('store-1:deploy'), 'PRIVATE-KEY-A')
  })
})

test('the extension that owns a store is found among several', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.other', 'store-9', 'deploy', 'PRIVATE-KEY-OTHER')
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    assert.equal(await resolveKeyContent('store-1:deploy'), 'PRIVATE-KEY-A')
    assert.equal(await resolveKeyContent('store-9:deploy'), 'PRIVATE-KEY-OTHER')
  })
})

test('a key under the two-level <scope>/<extension> layout is not found', async () => {
  await withCacheDir(async (extensions) => {
    // The layout that ids of the form <scope>/<extension> produced. An id is
    // one directory name now; a key left at this depth is not read.
    await plantKey(extensions, join('local', 'vault'), 'store-1', 'deploy', 'PRIVATE-KEY-OLD')

    await assert.rejects(() => resolveKeyContent('store-1:deploy'), /SSH key not found: deploy \(store: store-1\)/)
  })
})

test('a missing key names the key and its store', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    await assert.rejects(() => resolveKeyContent('store-1:absent'), /SSH key not found: absent \(store: store-1\)/)
    await assert.rejects(() => resolveKeyContent('store-2:deploy'), /SSH key not found: deploy \(store: store-2\)/)
  })
})

test('a plain path is read as a file, not looked up as a store key', async () => {
  await withCacheDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'terminal-keys-file-'))
    try {
      const file = join(dir, 'id_test')
      await writeFile(file, 'PRIVATE-KEY-FILE')

      assert.equal(await resolveKeyContent(file), 'PRIVATE-KEY-FILE')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
