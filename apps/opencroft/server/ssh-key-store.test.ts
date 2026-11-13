// Exercises the real database (embedded PGlite), so what is asserted about a
// stored row is what the column holds.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import { db, sshKey } from '@opencroft/db'
import { generateSshKey } from '@opencroft/terminal/server'
import { and, eq } from 'drizzle-orm'

import { KEYSTORE_SECRET_ENV, sshKeyMaterial, sshKeys } from './ssh-key-store'

const SECRET = 'test-keystore-secret'

/** Runs `run` with the variable set to `value` (unset for undefined), put back exactly afterwards. */
async function withSecret(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env[KEYSTORE_SECRET_ENV]
  if (value === undefined) {
    delete process.env[KEYSTORE_SECRET_ENV]
  } else {
    process.env[KEYSTORE_SECRET_ENV] = value
  }
  try {
    await run()
  } finally {
    if (saved === undefined) {
      delete process.env[KEYSTORE_SECRET_ENV]
    } else {
      process.env[KEYSTORE_SECRET_ENV] = saved
    }
  }
}

function newStoreId(): string {
  return `key-store-test-${crypto.randomUUID()}`
}

async function storedColumn(storeId: string, name: string): Promise<string> {
  const [row] = await db
    .select({ value: sshKey.privateKeyEncrypted })
    .from(sshKey)
    .where(and(eq(sshKey.storeId, storeId), eq(sshKey.name, name)))
  return row.value
}

test('a stored key is encrypted in its row, listed with its metadata, and read back whole', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    const key = generateSshKey('ed25519', 'deploy')

    assert.equal(await sshKeys.put(storeId, 'deploy', key, 'create'), true)

    const column = await storedColumn(storeId, 'deploy')
    assert.doesNotMatch(column, /PRIVATE KEY|BEGIN/)
    assert.doesNotMatch(Buffer.from(column, 'base64').toString('latin1'), /PRIVATE KEY/)
    assert.deepEqual(await sshKeys.list(storeId), [
      { name: 'deploy', type: key.type, fingerprint: key.fingerprint, publicKey: key.publicKey.trim() },
    ])
    assert.equal(await sshKeyMaterial.read(storeId, 'deploy'), key.privateKey)
  })
})

test('create refuses a name the store holds and keeps the stored key', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    const first = generateSshKey('ed25519', 'deploy')
    await sshKeys.put(storeId, 'deploy', first, 'create')

    assert.equal(await sshKeys.put(storeId, 'deploy', generateSshKey('ed25519', 'deploy'), 'create'), false)
    assert.equal(await sshKeyMaterial.read(storeId, 'deploy'), first.privateKey)
  })
})

test('replace changes a held key in place and stores nothing for a name the store does not hold', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    await sshKeys.put(storeId, 'deploy', generateSshKey('ed25519', 'deploy'), 'create')
    const next = generateSshKey('rsa', 'deploy')

    assert.equal(await sshKeys.put(storeId, 'deploy', next, 'replace'), true)
    assert.equal(await sshKeyMaterial.read(storeId, 'deploy'), next.privateKey)
    assert.equal((await sshKeys.get(storeId, 'deploy'))?.type, 'RSA')

    assert.equal(await sshKeys.put(storeId, 'absent', generateSshKey('ed25519'), 'replace'), false)
    assert.equal(await sshKeys.get(storeId, 'absent'), null)
  })
})

test('the public half is derived when none is given', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    const key = generateSshKey('ecdsa')

    await sshKeys.put(storeId, 'imported', { privateKey: key.privateKey }, 'create')

    const stored = await sshKeys.get(storeId, 'imported')
    assert.equal(stored?.fingerprint, key.fingerprint)
    const typeAndBlob = (line: string) => line.trim().split(' ').slice(0, 2).join(' ')
    assert.equal(typeAndBlob(stored?.publicKey ?? ''), typeAndBlob(key.publicKey))
  })
})

test('a value that is not a private key is refused without being quoted', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    await assert.rejects(
      () => sshKeys.put(storeId, 'deploy', { privateKey: 'not-a-key-value-1234' }, 'create'),
      (err: Error) => /not an SSH private key/.test(err.message) && !err.message.includes('not-a-key-value-1234'),
    )
    assert.deepEqual(await sshKeys.list(storeId), [])
  })
})

/** A private key as OpenSSL writes it, rather than as Key Store generates it; under `passphrase` when given. */
function pemKey(type: 'ed25519' | 'rsa' | 'ec', format: 'pkcs8' | 'pkcs1' | 'sec1', passphrase?: string): string {
  const { privateKey } =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : type === 'rsa'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const encryption = passphrase === undefined ? {} : { cipher: 'aes-256-cbc', passphrase }
  return privateKey.export({ type: format, format: 'pem', ...encryption }).toString()
}

/** The message `put` refuses `privateKey` with; fails the test when it stores the key or quotes it. */
async function refusal(storeId: string, privateKey: string): Promise<string> {
  const body = privateKey.split('\n')[1]
  let message = ''
  await assert.rejects(
    () => sshKeys.put(storeId, 'deploy', { privateKey }, 'create'),
    (err: Error) => {
      message = err.message
      return !message.includes(body)
    },
  )
  assert.deepEqual(await sshKeys.list(storeId), [])
  return message
}

test('a PKCS#8 RSA or EC key, which the SSH client cannot connect with, is refused naming OpenSSH format and ssh-keygen', async () => {
  await withSecret(SECRET, async () => {
    for (const type of ['rsa', 'ec'] as const) {
      const privateKey = pemKey(type, 'pkcs8')
      assert.match(privateKey, /^-----BEGIN PRIVATE KEY-----/)

      const message = await refusal(newStoreId(), privateKey)

      assert.match(message, /cannot be used to connect/, type)
      assert.ok(message.includes('-----BEGIN OPENSSH PRIVATE KEY-----'), type)
      assert.ok(message.includes('`ssh-keygen -p -f <key>`'), type)
    }
  })
})

test('a PKCS#8 Ed25519 key is refused naming OpenSSH format and a new key, not ssh-keygen, which cannot read it', async () => {
  await withSecret(SECRET, async () => {
    const privateKey = pemKey('ed25519', 'pkcs8')
    assert.match(privateKey, /^-----BEGIN PRIVATE KEY-----/)

    const message = await refusal(newStoreId(), privateKey)

    assert.match(message, /cannot be used to connect/)
    assert.ok(message.includes('-----BEGIN OPENSSH PRIVATE KEY-----'))
    assert.match(message, /generate a new key in the store/)
    assert.doesNotMatch(message, /ssh-keygen/)
  })
})

test('a PEM key under a passphrase, whose type is unread, is refused naming OpenSSH format, ssh-keygen and a new key', async () => {
  await withSecret(SECRET, async () => {
    const keys = [
      ['rsa', 'pkcs1', /^Proc-Type: 4,ENCRYPTED$/m],
      ['ec', 'sec1', /^Proc-Type: 4,ENCRYPTED$/m],
      ['rsa', 'pkcs8', /^-----BEGIN ENCRYPTED PRIVATE KEY-----/],
      ['ec', 'pkcs8', /^-----BEGIN ENCRYPTED PRIVATE KEY-----/],
      ['ed25519', 'pkcs8', /^-----BEGIN ENCRYPTED PRIVATE KEY-----/],
    ] as const
    for (const [type, format, marker] of keys) {
      const label = `${type} ${format}`
      const privateKey = pemKey(type, format, 'example-passphrase')
      assert.match(privateKey, marker, label)

      const message = await refusal(newStoreId(), privateKey)

      assert.match(message, /cannot be used to connect/, label)
      assert.ok(message.includes('-----BEGIN OPENSSH PRIVATE KEY-----'), label)
      assert.ok(message.includes('`ssh-keygen -p -f <key>`'), label)
      assert.match(message, /generate a new key in the store/, label)
    }
  })
})

test('a PEM block that holds no key is refused as not an SSH private key', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    await assert.rejects(
      () =>
        sshKeys.put(
          storeId,
          'deploy',
          { privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' },
          'create',
        ),
      /not an SSH private key/,
    )
    assert.deepEqual(await sshKeys.list(storeId), [])
  })
})

test('a traditional PEM RSA or EC key, which the SSH client reads, is stored', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()

    assert.equal(await sshKeys.put(storeId, 'rsa', { privateKey: pemKey('rsa', 'pkcs1') }, 'create'), true)
    assert.equal(await sshKeys.put(storeId, 'ec', { privateKey: pemKey('ec', 'sec1') }, 'create'), true)

    assert.deepEqual(
      (await sshKeys.list(storeId)).map((key) => [key.name, key.type]),
      [
        ['ec', 'ECDSA'],
        ['rsa', 'RSA'],
      ],
    )
  })
})

test('a cached file that does not parse is still backfilled, once, with unknown metadata', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    const content = '-----BEGIN OPENSSH PRIVATE KEY-----\ngarbled\n-----END OPENSSH PRIVATE KEY-----\n'

    assert.equal(await sshKeyMaterial.backfill(storeId, 'legacy', content), true)
    assert.equal(await sshKeyMaterial.backfill(storeId, 'legacy', 'other'), false)

    assert.deepEqual(await sshKeys.get(storeId, 'legacy'), {
      name: 'legacy',
      type: 'unknown',
      fingerprint: '',
      publicKey: null,
    })
    assert.equal(await sshKeyMaterial.read(storeId, 'legacy'), content)
  })
})

test('without the variable a stored key is not read, naming the variable, while the list still answers', async () => {
  const storeId = newStoreId()
  await withSecret(SECRET, async () => {
    await sshKeys.put(storeId, 'deploy', generateSshKey('ed25519'), 'create')
  })

  await withSecret(undefined, async () => {
    await assert.rejects(() => sshKeyMaterial.read(storeId, 'deploy'), new RegExp(`${KEYSTORE_SECRET_ENV} is not set`))
    await assert.rejects(
      () => sshKeys.put(storeId, 'other', generateSshKey('ed25519'), 'create'),
      new RegExp(`${KEYSTORE_SECRET_ENV} is not set`),
    )
    assert.deepEqual(
      (await sshKeys.list(storeId)).map((key) => key.name),
      ['deploy'],
    )
    // A key the database does not hold is a plain miss, which needs no secret.
    assert.equal(await sshKeyMaterial.read(storeId, 'absent'), null)
  })
})

test('under another value of the variable a stored key is refused as undecryptable', async () => {
  const storeId = newStoreId()
  await withSecret(SECRET, async () => {
    await sshKeys.put(storeId, 'deploy', generateSshKey('ed25519'), 'create')
  })

  await withSecret('another-secret', async () => {
    await assert.rejects(() => sshKeyMaterial.read(storeId, 'deploy'), {
      name: 'UndecryptableKeyError',
      message: new RegExp(`deploy \\(store: ${storeId}\\).*${KEYSTORE_SECRET_ENV}`),
    })
  })
})

test('a ciphertext copied into another key’s row does not decrypt there', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    await sshKeys.put(storeId, 'a', generateSshKey('ed25519'), 'create')
    await sshKeys.put(storeId, 'b', generateSshKey('ed25519'), 'create')

    await db
      .update(sshKey)
      .set({ privateKeyEncrypted: await storedColumn(storeId, 'a') })
      .where(and(eq(sshKey.storeId, storeId), eq(sshKey.name, 'b')))

    await assert.rejects(() => sshKeyMaterial.read(storeId, 'b'), { name: 'UndecryptableKeyError' })
  })
})

test('delete removes a held key and answers false for one the store does not hold', async () => {
  await withSecret(SECRET, async () => {
    const storeId = newStoreId()
    await sshKeys.put(storeId, 'deploy', generateSshKey('ed25519'), 'create')

    assert.equal(await sshKeys.delete(storeId, 'deploy'), true)
    assert.equal(await sshKeys.delete(storeId, 'deploy'), false)
    assert.equal(await sshKeyMaterial.read(storeId, 'deploy'), null)
  })
})
