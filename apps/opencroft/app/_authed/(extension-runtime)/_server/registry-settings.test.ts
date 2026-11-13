// The registries added in Settings: how the stored list is read and written,
// what a registry may be stored as, and how they join the default and the
// environment's in the list every search and install reads.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getRegistrySources, storedRegistryProblem } from '@/app/_authed/(extension-runtime)/_server/registry'
import {
  listStoredRegistries,
  readStoredRegistries,
  removeStoredRegistry,
  repositoryProblem,
  saveStoredRegistry,
  storedRegistryAuth,
} from '@/app/_authed/(extension-runtime)/_server/registry-settings'

const USER = { storeId: 'store-a', key: 'REGISTRY_USER' }
const TOKEN = { storeId: 'store-a', key: 'REGISTRY_TOKEN' }

/** The environment variable set to `value` (or unset) for `run`, then put back. */
async function withRegistriesEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env.OPENCROFT_EXTENSION_REGISTRIES
  if (value === undefined) {
    delete process.env.OPENCROFT_EXTENSION_REGISTRIES
  } else {
    process.env.OPENCROFT_EXTENSION_REGISTRIES = value
  }
  try {
    await run()
  } finally {
    if (saved === undefined) {
      delete process.env.OPENCROFT_EXTENSION_REGISTRIES
    } else {
      process.env.OPENCROFT_EXTENSION_REGISTRIES = saved
    }
  }
}

/** Every stored registry removed, so a test starts from none. */
async function clearStored(): Promise<void> {
  for (const item of await listStoredRegistries()) {
    await removeStoredRegistry(item.id)
  }
}

test('the stored list keeps well-formed rows and skips the rest', () => {
  const read = readStoredRegistries({
    registries: [
      { id: 'a', repository: 'acme/registry', username: USER, password: TOKEN },
      { id: 'b', repository: 'https://git.example.com/org/registry.git', password: { storeId: '', key: 'X' } },
      { id: 'c', repository: '  ' },
      { repository: 'no/id' },
      null,
    ],
  })
  assert.deepEqual(read, [
    { id: 'a', repository: 'acme/registry', username: USER, password: TOKEN },
    { id: 'b', repository: 'https://git.example.com/org/registry.git' },
  ])
  assert.deepEqual(readStoredRegistries({}), [])
})

test('a stored registry signs in through the store and keys it picked, as an install records them', () => {
  assert.deepEqual(storedRegistryAuth({ id: 'a', repository: 'acme/registry', username: USER, password: TOKEN }), {
    type: 'secret',
    storeId: 'store-a',
    tokenKey: 'REGISTRY_TOKEN',
    usernameKey: 'REGISTRY_USER',
  })
  assert.deepEqual(storedRegistryAuth({ id: 'a', repository: 'acme/registry', password: TOKEN }), {
    type: 'secret',
    storeId: 'store-a',
    tokenKey: 'REGISTRY_TOKEN',
  })
  assert.equal(storedRegistryAuth({ id: 'a', repository: 'acme/registry' }), undefined)
})

test('a repository is owner/repo or an http(s) URL without credentials', () => {
  assert.equal(repositoryProblem('acme/registry'), undefined)
  assert.equal(repositoryProblem('https://git.example.com/org/registry.git'), undefined)
  assert.match(repositoryProblem('') ?? '', /Give the repository/)
  assert.match(repositoryProblem('not a repository') ?? '', /neither owner\/repo nor a URL/)
  assert.match(repositoryProblem('ssh://git.example.com/org/registry.git') ?? '', /https:\/\/ or http:\/\//)
  assert.match(repositoryProblem('https://user:pass@git.example.com/org/registry.git') ?? '', /Secrets Store/)
})

test('a username needs a password, and both come from one store', async () => {
  assert.match((await storedRegistryProblem({ repository: 'acme/one', username: USER })) ?? '', /password or token/)
  assert.match(
    (await storedRegistryProblem({
      repository: 'acme/one',
      username: USER,
      password: { storeId: 'store-b', key: 'REGISTRY_TOKEN' },
    })) ?? '',
    /same Secrets Store/,
  )
})

test('a pick that names no key of any Secrets Store is refused', async () => {
  assert.match(
    (await storedRegistryProblem({ repository: 'acme/one', password: { storeId: 'no-such-store', key: 'T' } })) ?? '',
    /not in a Secrets Store on this instance/,
  )
})

test('saved registries follow the default and the environment, and a registry named twice is read once', async () => {
  await clearStored()
  await withRegistriesEnv('ops/extensions', async () => {
    const added = await saveStoredRegistry({ repository: 'https://git.example.com/team/registry.git' })
    const twice = await saveStoredRegistry({ repository: 'https://github.com/ops/extensions.git' })
    try {
      const sources = await getRegistrySources()
      assert.deepEqual(
        sources.map((source) => [source.origin, source.url]),
        [
          ['default', 'opencroft/registry'],
          ['environment', 'ops/extensions'],
          ['settings', 'https://git.example.com/team/registry.git'],
        ],
      )
      assert.equal(sources[2].id, added.id)
      assert.notEqual(twice.id, added.id)
    } finally {
      await clearStored()
    }
  })
})

test('a registry already listed is refused, except the stored one being edited at its own address', async () => {
  await clearStored()
  await withRegistriesEnv('ops/extensions', async () => {
    const added = await saveStoredRegistry({ repository: 'acme/team-registry' })
    try {
      assert.match((await storedRegistryProblem({ repository: 'opencroft/registry' })) ?? '', /default registry/)
      assert.match(
        (await storedRegistryProblem({ repository: 'https://github.com/ops/extensions.git' })) ?? '',
        /from the environment/,
      )
      assert.match((await storedRegistryProblem({ repository: 'ACME/team-registry' })) ?? '', /is listed already/)
      assert.equal(await storedRegistryProblem({ id: added.id, repository: 'acme/team-registry' }), undefined)
    } finally {
      await clearStored()
    }
  })
})

test('an edit replaces its registry in place, and one removed is not edited back', async () => {
  await clearStored()
  const first = await saveStoredRegistry({ repository: 'acme/first' })
  const second = await saveStoredRegistry({ repository: 'acme/second' })
  try {
    await saveStoredRegistry({ id: first.id, repository: 'acme/renamed', password: TOKEN })
    assert.deepEqual(await listStoredRegistries(), [
      { id: first.id, repository: 'acme/renamed', password: TOKEN },
      { id: second.id, repository: 'acme/second' },
    ])

    assert.equal(await removeStoredRegistry(first.id), true)
    assert.equal(await removeStoredRegistry(first.id), false)
    await assert.rejects(saveStoredRegistry({ id: first.id, repository: 'acme/back' }), /not in Settings any more/)
    assert.deepEqual(await listStoredRegistries(), [{ id: second.id, repository: 'acme/second' }])
  } finally {
    await clearStored()
  }
})
