import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  copyCachedKeys,
  type KeyStoreAccessCheck,
  type KeyStoreMaterial,
  registerKeyStoreAccess,
  registerKeyStoreMaterial,
  removeCachedKeyStores,
  resolveKeyContent,
} from './keys'

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

const admitAll: KeyStoreAccessCheck = async () => {}

/** For `copyCachedKeys`: every store's node is on a graph. */
const everyStore = () => true

/** Runs `run` with `check` as the host's rule, recording what it was asked; every store is admitted afterwards. */
async function withAccessCheck(
  check: KeyStoreAccessCheck,
  run: (asked: [string, string | undefined][]) => Promise<void>,
): Promise<void> {
  const asked: [string, string | undefined][] = []
  registerKeyStoreAccess(async (storeId, scope) => {
    asked.push([storeId, scope])
    await check(storeId, scope)
  })
  try {
    await run(asked)
  } finally {
    registerKeyStoreAccess(admitAll)
  }
}

// First in the file: every later test registers a check, and nothing unregisters one.
test('until the host registers its check, no store key is read', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    await assert.rejects(
      () => resolveKeyContent('store-1:deploy', 'server-1'),
      /the host has not said which nodes may use which stores/,
    )
  })
})

test('a store key is read from <cache>/extensions/<extensionId>/key-store, one directory below extensions', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    await withAccessCheck(admitAll, async () => {
      assert.equal(await resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-A')
    })
  })
})

test('the extension that owns a store is found among several', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.other', 'store-9', 'deploy', 'PRIVATE-KEY-OTHER')
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    await withAccessCheck(admitAll, async () => {
      assert.equal(await resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-A')
      assert.equal(await resolveKeyContent('store-9:deploy', 'server-1'), 'PRIVATE-KEY-OTHER')
    })
  })
})

test('a key under the two-level <scope>/<extension> layout is not found', async () => {
  await withCacheDir(async (extensions) => {
    // The layout that ids of the form <scope>/<extension> produced. An id is
    // one directory name now; a key left at this depth is not read.
    await plantKey(extensions, join('local', 'vault'), 'store-1', 'deploy', 'PRIVATE-KEY-OLD')

    await withAccessCheck(admitAll, async () => {
      await assert.rejects(
        () => resolveKeyContent('store-1:deploy', 'server-1'),
        /SSH key not found: deploy \(store: store-1\)/,
      )
    })
  })
})

test('a missing key names the key and its store', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    await withAccessCheck(admitAll, async () => {
      await assert.rejects(
        () => resolveKeyContent('store-1:absent', 'server-1'),
        /SSH key not found: absent \(store: store-1\)/,
      )
      await assert.rejects(
        () => resolveKeyContent('store-2:deploy', 'server-1'),
        /SSH key not found: deploy \(store: store-2\)/,
      )
    })
  })
})

test('the host’s check is asked with the store and the scope before a store key is read', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')

    await withAccessCheck(admitAll, async (asked) => {
      await resolveKeyContent('store-1:deploy', 'server-1')
      await resolveKeyContent('store-1:deploy', undefined)
      assert.deepEqual(asked, [
        ['store-1', 'server-1'],
        ['store-1', undefined],
      ])
    })
  })
})

test('a store key the host’s check refuses is not read, and the refusal is what the caller gets', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-A')
    const refuse: KeyStoreAccessCheck = async (storeId, scope) => {
      throw new Error(`store ${storeId} is not for ${scope}`)
    }

    await withAccessCheck(refuse, async () => {
      await assert.rejects(
        () => resolveKeyContent('store-1:deploy', 'server-2'),
        /^Error: store store-1 is not for server-2$/,
      )
    })
  })
})

test('a plain path is read as a file, without asking the host’s check', async () => {
  await withCacheDir(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'terminal-keys-file-'))
    try {
      const file = join(dir, 'id_test')
      await writeFile(file, 'PRIVATE-KEY-FILE')

      await withAccessCheck(admitAll, async (asked) => {
        assert.equal(await resolveKeyContent(file, undefined), 'PRIVATE-KEY-FILE')
        assert.deepEqual(asked, [])
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** A host key store in memory, recording what was copied into it. `failBackfill` makes every copy throw. */
function memoryMaterial(held: Record<string, string> = {}, failBackfill?: Error) {
  const stored = new Map(Object.entries(held))
  const backfilled: string[] = []
  const store: KeyStoreMaterial = {
    read: async (storeId, name) => stored.get(`${storeId}:${name}`) ?? null,
    backfill: async (storeId, name, content) => {
      if (failBackfill) {
        throw failBackfill
      }
      const ref = `${storeId}:${name}`
      if (stored.has(ref)) {
        return false
      }
      stored.set(ref, content)
      backfilled.push(ref)
      return true
    },
  }
  return { store, stored, backfilled }
}

// Registered from here on: the tests above run with no host store, as a
// process does before the host registers its own.
test('a key the host’s store holds is read from it, and the cache file is not consulted', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-FILE')
    const { store, backfilled } = memoryMaterial({ 'store-1:deploy': 'PRIVATE-KEY-STORED' })
    registerKeyStoreMaterial(store)

    await withAccessCheck(admitAll, async () => {
      assert.equal(await resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-STORED')
    })
    assert.deepEqual(backfilled, [])
  })
})

test('a key only in a cache file is read from it and copied into the host’s store, which answers next time', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-FILE')
    const { store, stored, backfilled } = memoryMaterial()
    registerKeyStoreMaterial(store)

    await withAccessCheck(admitAll, async () => {
      assert.equal(await resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-FILE')
      assert.deepEqual(backfilled, ['store-1:deploy'])

      stored.set('store-1:deploy', 'PRIVATE-KEY-ROTATED')
      assert.equal(await resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-ROTATED')
    })
  })
})

test('a cached key that cannot be copied is still used', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-FILE')
    registerKeyStoreMaterial(memoryMaterial({}, new Error('OPENCROFT_KEYSTORE_SECRET is not set')).store)

    await withAccessCheck(admitAll, async () => {
      assert.equal(await resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-FILE')
    })
  })
})

test('a key the host’s store holds but cannot read fails with the store’s reason, not with the cache file', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-FILE')
    registerKeyStoreMaterial({
      read: async () => {
        throw new Error('OPENCROFT_KEYSTORE_SECRET is not set')
      },
      backfill: async () => true,
    })

    await withAccessCheck(admitAll, async () => {
      await assert.rejects(
        () => resolveKeyContent('store-1:deploy', 'server-1'),
        /OPENCROFT_KEYSTORE_SECRET is not set/,
      )
    })
  })
})

test('a store key the host’s check refuses is read neither from the host’s store nor from a file', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', 'PRIVATE-KEY-FILE')
    const read: string[] = []
    registerKeyStoreMaterial({
      read: async (storeId, name) => {
        read.push(`${storeId}:${name}`)
        return null
      },
      backfill: async () => true,
    })

    await withAccessCheck(
      async () => {
        throw new Error('refused')
      },
      async () => {
        await assert.rejects(() => resolveKeyContent('store-1:deploy', 'server-2'), /^Error: refused$/)
      },
    )
    assert.deepEqual(read, [])
  })
})

test('copying cached keys stores each private key once, skips public halves and staging, and leaves the files', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', '-----BEGIN OPENSSH PRIVATE KEY-----\nA')
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy.pub', 'ssh-ed25519 AAAA deploy')
    await plantKey(extensions, 'acme.vault', 'store-1', 'notes', 'not a key')
    await plantKey(extensions, 'acme.vault', 'store-2', 'held', '-----BEGIN OPENSSH PRIVATE KEY-----\nB')
    await mkdir(join(extensions, 'acme.vault', 'key-store', 'store-1', '.rotate-x'), { recursive: true })
    const { store, stored } = memoryMaterial({ 'store-2:held': 'STORED' })
    registerKeyStoreMaterial(store)

    assert.deepEqual(await copyCachedKeys(everyStore), { copied: 1, present: 1, failed: 0 })
    assert.deepEqual([...stored.keys()].sort(), ['store-1:deploy', 'store-2:held'])
    assert.equal(stored.get('store-2:held'), 'STORED')

    await withAccessCheck(admitAll, async () => {
      stored.clear()
      assert.match(
        (await resolveKeyContent('store-1:deploy', 'server-1')) ?? '',
        /^-----BEGIN OPENSSH PRIVATE KEY-----/,
      )
    })
  })
})

test('a cached key that cannot be copied is counted as failed, not thrown', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', '-----BEGIN OPENSSH PRIVATE KEY-----\nA')
    registerKeyStoreMaterial(memoryMaterial({}, new Error('database is down')).store)

    assert.deepEqual(await copyCachedKeys(everyStore), { copied: 0, present: 0, failed: 1 })
  })
})

test('copying cached keys leaves the files of a store whose node is gone on disk and out of the store', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-live', 'deploy', '-----BEGIN OPENSSH PRIVATE KEY-----\nA')
    await plantKey(extensions, 'acme.vault', 'store-gone', 'old', '-----BEGIN OPENSSH PRIVATE KEY-----\nB')
    const { store, stored } = memoryMaterial({})
    registerKeyStoreMaterial(store)

    assert.deepEqual(await copyCachedKeys((storeId) => storeId === 'store-live'), { copied: 1, present: 0, failed: 0 })
    assert.deepEqual([...stored.keys()], ['store-live:deploy'])

    stored.clear()
    assert.deepEqual(await copyCachedKeys(everyStore), { copied: 2, present: 0, failed: 0 })
  })
})

test('removing stores’ cache files removes them under every extension and leaves other stores’', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', '-----BEGIN OPENSSH PRIVATE KEY-----\nA')
    await plantKey(extensions, 'other.keys', 'store-1', 'old', '-----BEGIN OPENSSH PRIVATE KEY-----\nB')
    await plantKey(extensions, 'acme.vault', 'store-2', 'held', '-----BEGIN OPENSSH PRIVATE KEY-----\nC')
    await plantKey(extensions, 'acme.vault', 'store-3', 'gone', '-----BEGIN OPENSSH PRIVATE KEY-----\nD')
    const { store, stored } = memoryMaterial({})
    registerKeyStoreMaterial(store)

    await removeCachedKeyStores(['store-1', 'store-3', 'store-without-files'])

    assert.deepEqual(await copyCachedKeys(everyStore), { copied: 1, present: 0, failed: 0 })
    assert.deepEqual([...stored.keys()], ['store-2:held'])
  })
})

test('removing cache files when the cache has no extensions is not an error', async () => {
  await withCacheDir(async () => {
    await removeCachedKeyStores(['store-1'])
  })
})

test('an id that is no store directory reaches nothing outside the stores', async () => {
  await withCacheDir(async (extensions) => {
    await plantKey(extensions, 'acme.vault', 'store-1', 'deploy', '-----BEGIN OPENSSH PRIVATE KEY-----\nA')
    const { store, stored } = memoryMaterial({})
    registerKeyStoreMaterial(store)

    await removeCachedKeyStores(['', '.', '..', '../key-store', 'store-1/deploy', 'acme.vault'])

    assert.deepEqual(await copyCachedKeys(everyStore), { copied: 1, present: 0, failed: 0 })
    assert.deepEqual([...stored.keys()], ['store-1:deploy'])
  })
})

// A production build bundles this module into more than one output, and the
// host registers through one of them.
test('a second copy of the module reads store keys under the rule and store registered through the first', async () => {
  // A query makes the loader evaluate the file again; a specifier held in a
  // variable keeps the type checker from resolving the query as a file name.
  const secondCopy = './keys?second-copy'
  const second: typeof import('./keys') = await import(secondCopy)
  assert.notEqual(second.resolveKeyContent, resolveKeyContent, 'the second import is a module copy of its own')

  const { store } = memoryMaterial({ 'store-1:deploy': 'PRIVATE-KEY-FROM-STORE' })
  registerKeyStoreMaterial(store)
  await withAccessCheck(
    async (storeId) => {
      if (storeId !== 'store-1') {
        throw new Error(`refused: ${storeId}`)
      }
    },
    async (asked) => {
      assert.equal(await second.resolveKeyContent('store-1:deploy', 'server-1'), 'PRIVATE-KEY-FROM-STORE')
      await assert.rejects(() => second.resolveKeyContent('store-2:deploy', 'server-1'), /refused: store-2/)
      assert.deepEqual(asked, [
        ['store-1', 'server-1'],
        ['store-2', 'server-1'],
      ])
    },
  )
})
