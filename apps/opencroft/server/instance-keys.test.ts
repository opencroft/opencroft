// The startup step that prepares the instance keys, against the real database
// (embedded PGlite) and a key file in a directory of each test's own: a fresh
// instance, an instance upgrading from the legacy key, the environment taking
// precedence, and the keys' former variable names.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { db, secret } from '@opencroft/db'

import { canDecrypt, encrypt, LEGACY_DEFAULT_SECRETS_KEY, UndecryptableSecretError } from './crypto'
import { instanceKeysStatus, prepareInstanceKeys } from './instance-keys'
import { secrets } from './secrets'

const KEY_VARIABLES = ['OPENCROFT_SECRETS_KEY', 'OPENCROFT_AUTH_SECRET', 'SECRETS_KEY', 'BETTER_AUTH_SECRET'] as const
const ENV_KEYS = ['OPENCROFT_DATA_DIR', ...KEY_VARIABLES] as const

// An instance with an empty data directory, no key variables under either
// name and no stored secrets; the environment is put back exactly as it was
// afterwards. Returns what prepareInstanceKeys logs, so a test can check no
// key reaches the log.
async function asInstance(
  t: TestContext,
  body: (ctx: { keyFile: string; logged: () => string }) => Promise<void>,
): Promise<void> {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  const dir = mkdtempSync(join(tmpdir(), 'opencroft-instance-keys-app-'))
  process.env.OPENCROFT_DATA_DIR = dir
  for (const name of KEY_VARIABLES) {
    delete process.env[name]
  }
  await db.delete(secret)
  const lines: string[] = []
  for (const method of ['log', 'warn', 'error'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
  }
  try {
    await body({ keyFile: join(dir, 'instance-secrets.json'), logged: () => lines.join('\n') })
  } finally {
    t.mock.restoreAll()
    await db.delete(secret)
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function keysIn(keyFile: string): Record<string, string> {
  return JSON.parse(readFileSync(keyFile, 'utf8'))
}

// A row as an instance on the given key wrote it.
async function storeUnderKey(passphrase: string, storeId: string, key: string, value: string): Promise<void> {
  const previous = process.env.OPENCROFT_SECRETS_KEY
  process.env.OPENCROFT_SECRETS_KEY = passphrase
  try {
    await db.insert(secret).values({ storeId, key, value: encrypt(value) })
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCROFT_SECRETS_KEY
    } else {
      process.env.OPENCROFT_SECRETS_KEY = previous
    }
  }
}

test('a fresh instance gets random keys of its own in the key file, and logs the notice without them', async (t) => {
  await asInstance(t, async ({ keyFile, logged }) => {
    await prepareInstanceKeys()

    const keys = keysIn(keyFile)
    assert.deepEqual(Object.keys(keys).sort(), ['OPENCROFT_AUTH_SECRET', 'OPENCROFT_SECRETS_KEY'])
    assert.notEqual(
      keys.OPENCROFT_SECRETS_KEY,
      LEGACY_DEFAULT_SECRETS_KEY,
      'a fresh instance never takes the published key',
    )

    await secrets.set('store-a', 'TOKEN', 'stored-value')
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'stored-value')

    assert.match(logged(), new RegExp(`Instance keys are stored in ${keyFile} in the data volume\\.`))
    for (const value of Object.values(keys)) {
      assert.ok(!logged().includes(value), 'no key value is logged')
    }
    assert.deepEqual(instanceKeysStatus().sources, { OPENCROFT_SECRETS_KEY: 'file', OPENCROFT_AUTH_SECRET: 'file' })
  })
})

test('a restart, or a new container on the same volume, reads the same keys back', async (t) => {
  await asInstance(t, async ({ keyFile }) => {
    await prepareInstanceKeys()
    const first = keysIn(keyFile)
    await secrets.set('store-a', 'TOKEN', 'stored-value')

    await prepareInstanceKeys()
    assert.deepEqual(keysIn(keyFile), first)
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'stored-value')
  })
})

test('an instance upgrading with secrets under the legacy key keeps that key in the file, so they stay readable', async (t) => {
  await asInstance(t, async ({ keyFile, logged }) => {
    await storeUnderKey(LEGACY_DEFAULT_SECRETS_KEY, 'store-a', 'TOKEN', 'legacy-value')

    await prepareInstanceKeys()

    assert.equal(keysIn(keyFile).OPENCROFT_SECRETS_KEY, LEGACY_DEFAULT_SECRETS_KEY)
    assert.notEqual(keysIn(keyFile).OPENCROFT_AUTH_SECRET, undefined)
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'legacy-value')
    assert.equal(await secrets.countUndecryptable(), 0)
    assert.match(logged(), /former built-in secrets key/)
    assert.match(logged(), /set a new OPENCROFT_SECRETS_KEY/)
    assert.ok(!logged().includes(LEGACY_DEFAULT_SECRETS_KEY), 'not even the published key is logged')
  })
})

test('a key file written before the rename keeps working and is left as it was', async (t) => {
  await asInstance(t, async ({ keyFile, logged }) => {
    await storeUnderKey('key-from-the-former-file', 'store-a', 'TOKEN', 'stored-value')
    const before = JSON.stringify({
      SECRETS_KEY: 'key-from-the-former-file',
      BETTER_AUTH_SECRET: 'auth-from-the-former-file',
    })
    writeFileSync(keyFile, before)

    await prepareInstanceKeys()

    assert.equal(readFileSync(keyFile, 'utf8'), before)
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'stored-value')
    assert.deepEqual(instanceKeysStatus().sources, { OPENCROFT_SECRETS_KEY: 'file', OPENCROFT_AUTH_SECRET: 'file' })
    assert.ok(!logged().includes('key-from-the-former-file') && !logged().includes('auth-from-the-former-file'))
  })
})

test('secrets under some other key do not make the instance take the legacy key, and say so when read', async (t) => {
  await asInstance(t, async ({ keyFile }) => {
    await storeUnderKey('a-key-from-another-instance', 'store-a', 'TOKEN', 'foreign-value')

    await prepareInstanceKeys()

    assert.notEqual(keysIn(keyFile).OPENCROFT_SECRETS_KEY, LEGACY_DEFAULT_SECRETS_KEY)
    assert.equal(await secrets.countUndecryptable(), 1)
    await assert.rejects(
      () => secrets.get('store-a', 'TOKEN'),
      (err: Error) => {
        assert.ok(err instanceof UndecryptableSecretError)
        assert.match(err.message, /could not be decrypted with this instance's OPENCROFT_SECRETS_KEY/)
        assert.ok(err.message.includes(keyFile), 'the message says where the key in use comes from')
        assert.ok(!err.message.includes('foreign-value'))
        return true
      },
    )
  })
})

test('OPENCROFT_SECRETS_KEY from the environment wins: the file gets only the session secret', async (t) => {
  await asInstance(t, async ({ keyFile }) => {
    await storeUnderKey(LEGACY_DEFAULT_SECRETS_KEY, 'store-a', 'TOKEN', 'legacy-value')
    process.env.OPENCROFT_SECRETS_KEY = 'configured-secrets-key'

    await prepareInstanceKeys()

    assert.deepEqual(Object.keys(keysIn(keyFile)), ['OPENCROFT_AUTH_SECRET'])
    assert.deepEqual(instanceKeysStatus().sources, { OPENCROFT_SECRETS_KEY: 'env', OPENCROFT_AUTH_SECRET: 'file' })
  })
})

test('only the new names set: both keys come from them, with no key file, no notice and no deprecation', async (t) => {
  await asInstance(t, async ({ keyFile, logged }) => {
    process.env.OPENCROFT_SECRETS_KEY = 'configured-secrets-key-new'
    process.env.OPENCROFT_AUTH_SECRET = 'configured-auth-secret-new'

    await prepareInstanceKeys()
    await secrets.set('store-a', 'TOKEN', 'stored-value')

    assert.equal(existsSync(keyFile), false)
    assert.equal(instanceKeysStatus().notice, null)
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'stored-value')
    assert.doesNotMatch(logged(), /Instance keys are stored|deprecated|\[env\]/)
  })
})

test('only the former names set: they are used, each logs one deprecation line, and no value is logged', async (t) => {
  await asInstance(t, async ({ keyFile, logged }) => {
    process.env.SECRETS_KEY = 'configured-secrets-key-former'
    process.env.BETTER_AUTH_SECRET = 'configured-auth-secret-former'

    await prepareInstanceKeys()
    await secrets.set('store-a', 'TOKEN', 'stored-value')
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'stored-value')

    assert.equal(existsSync(keyFile), false)
    assert.deepEqual(instanceKeysStatus().sources, { OPENCROFT_SECRETS_KEY: 'env', OPENCROFT_AUTH_SECRET: 'env' })
    const row = await db.query.secret.findFirst({ columns: { value: true } })
    assert.ok(
      row && canDecrypt(row.value, 'configured-secrets-key-former'),
      'encrypted under the value of the former name',
    )

    const lines = logged().split('\n')
    assert.equal(lines.filter((line) => line.includes('SECRETS_KEY is deprecated')).length, 1)
    assert.equal(lines.filter((line) => line.includes('BETTER_AUTH_SECRET is deprecated')).length, 1)
    assert.match(logged(), /rename it to OPENCROFT_SECRETS_KEY/)
    assert.match(logged(), /rename it to OPENCROFT_AUTH_SECRET/)
    assert.doesNotMatch(logged(), /configured-(secrets-key|auth-secret)-former/)
  })
})

test('both names set: the new ones are used, the log says so, and no value is logged', async (t) => {
  await asInstance(t, async ({ keyFile, logged }) => {
    process.env.OPENCROFT_SECRETS_KEY = 'configured-secrets-key-new'
    process.env.SECRETS_KEY = 'configured-secrets-key-former'
    process.env.OPENCROFT_AUTH_SECRET = 'configured-auth-secret-new'
    process.env.BETTER_AUTH_SECRET = 'configured-auth-secret-former'

    await prepareInstanceKeys()
    await secrets.set('store-a', 'TOKEN', 'stored-value')
    assert.equal(await secrets.get('store-a', 'TOKEN'), 'stored-value')
    const row = await db.query.secret.findFirst({ columns: { value: true } })
    assert.ok(row && canDecrypt(row.value, 'configured-secrets-key-new'), 'encrypted under the value of the new name')
    assert.ok(!canDecrypt(row.value, 'configured-secrets-key-former'), 'and not under the former one')

    assert.equal(existsSync(keyFile), false)
    assert.match(logged(), /Both OPENCROFT_SECRETS_KEY and SECRETS_KEY are set: using OPENCROFT_SECRETS_KEY/)
    assert.match(logged(), /Both OPENCROFT_AUTH_SECRET and BETTER_AUTH_SECRET are set: using OPENCROFT_AUTH_SECRET/)
    assert.doesNotMatch(logged(), /configured-(secrets-key|auth-secret)-(new|former)/)
  })
})

test('nothing encrypts before the key exists, rather than inventing one', async (t) => {
  await asInstance(t, async ({ keyFile }) => {
    assert.throws(() => encrypt('anything'), /OPENCROFT_SECRETS_KEY is not set/)
    assert.equal(existsSync(keyFile), false)
  })
})
