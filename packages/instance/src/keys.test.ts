import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureInstanceKey,
  INSTANCE_KEY_NAMES,
  instanceKeyFile,
  instanceKeySources,
  keyFileNotice,
  readInstanceKey,
} from './keys'

const FORMER_NAMES = ['BETTER_AUTH_SECRET', 'SECRETS_KEY'] as const
const ENV_KEYS = ['OPENCROFT_DATA_DIR', ...INSTANCE_KEY_NAMES, ...FORMER_NAMES] as const

// Each test gets an empty data directory and no key variable set under either
// name, and the environment is put back exactly as it was afterwards.
function withDataDir(body: (dir: string) => void): void {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  const dir = mkdtempSync(join(tmpdir(), 'opencroft-instance-keys-'))
  process.env.OPENCROFT_DATA_DIR = dir
  for (const name of [...INSTANCE_KEY_NAMES, ...FORMER_NAMES]) {
    delete process.env[name]
  }
  try {
    body(dir)
  } finally {
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

function fileContents(): Record<string, string> {
  return JSON.parse(readFileSync(instanceKeyFile(), 'utf8'))
}

test('the key file lives in the data directory', () => {
  withDataDir((dir) => {
    assert.equal(instanceKeyFile(), join(dir, 'instance-secrets.json'))
  })
})

test('a missing key is generated, saved owner-only under its new name, and read back unchanged', () => {
  withDataDir(() => {
    const first = ensureInstanceKey('OPENCROFT_SECRETS_KEY')
    assert.equal(first.source, 'file')
    assert.ok(first.value.length >= 32, `a generated key is at least 32 characters, got ${first.value.length}`)
    assert.deepEqual(fileContents(), { OPENCROFT_SECRETS_KEY: first.value })
    assert.equal(statSync(instanceKeyFile()).mode & 0o777, 0o600)

    assert.deepEqual(ensureInstanceKey('OPENCROFT_SECRETS_KEY'), first, 'a later start reads the same key back')
    assert.deepEqual(readInstanceKey('OPENCROFT_SECRETS_KEY'), first)
  })
})

test('each key is generated on its own, with a value of its own, keeping the other entries', () => {
  withDataDir(() => {
    const secretsKey = ensureInstanceKey('OPENCROFT_SECRETS_KEY').value
    const authSecret = ensureInstanceKey('OPENCROFT_AUTH_SECRET').value
    assert.notEqual(secretsKey, authSecret)
    assert.deepEqual(fileContents(), { OPENCROFT_SECRETS_KEY: secretsKey, OPENCROFT_AUTH_SECRET: authSecret })
  })
})

test('initialValue decides what a new key is, and is not consulted once one exists', () => {
  withDataDir(() => {
    assert.equal(ensureInstanceKey('OPENCROFT_SECRETS_KEY', () => 'chosen-value').value, 'chosen-value')
    assert.equal(
      ensureInstanceKey('OPENCROFT_SECRETS_KEY', () => assert.fail('must not be called for an existing key')).value,
      'chosen-value',
    )
  })
})

test('an environment variable wins over the file, for each key separately, and is never written to it', () => {
  withDataDir(() => {
    writeFileSync(
      instanceKeyFile(),
      JSON.stringify({ OPENCROFT_SECRETS_KEY: 'file-secrets', OPENCROFT_AUTH_SECRET: 'file-auth' }),
    )
    process.env.OPENCROFT_SECRETS_KEY = 'env-secrets'

    assert.deepEqual(ensureInstanceKey('OPENCROFT_SECRETS_KEY'), { value: 'env-secrets', source: 'env' })
    assert.deepEqual(ensureInstanceKey('OPENCROFT_AUTH_SECRET'), { value: 'file-auth', source: 'file' })
    assert.deepEqual(instanceKeySources(), { OPENCROFT_SECRETS_KEY: 'env', OPENCROFT_AUTH_SECRET: 'file' })
    assert.equal(fileContents().OPENCROFT_SECRETS_KEY, 'file-secrets', 'the file is left as it was')
  })
})

test('only the former variable names set: their values are used as the environment, and no file is made', () => {
  withDataDir(() => {
    process.env.SECRETS_KEY = 'former-env-secrets'
    process.env.BETTER_AUTH_SECRET = 'former-env-auth'
    assert.deepEqual(ensureInstanceKey('OPENCROFT_SECRETS_KEY'), { value: 'former-env-secrets', source: 'env' })
    assert.deepEqual(ensureInstanceKey('OPENCROFT_AUTH_SECRET'), { value: 'former-env-auth', source: 'env' })
    assert.equal(existsSync(instanceKeyFile()), false)
  })
})

test('both variable names set: the new one wins', () => {
  withDataDir(() => {
    process.env.SECRETS_KEY = 'former-env-secrets'
    process.env.OPENCROFT_SECRETS_KEY = 'new-env-secrets'
    assert.deepEqual(readInstanceKey('OPENCROFT_SECRETS_KEY'), { value: 'new-env-secrets', source: 'env' })
  })
})

test('a key file written before the rename is read under its former entry names', () => {
  withDataDir(() => {
    writeFileSync(instanceKeyFile(), JSON.stringify({ SECRETS_KEY: 'former-file-secrets' }))
    assert.deepEqual(readInstanceKey('OPENCROFT_SECRETS_KEY'), { value: 'former-file-secrets', source: 'file' })
    assert.deepEqual(
      ensureInstanceKey('OPENCROFT_SECRETS_KEY', () => assert.fail('an existing key is not generated again')),
      { value: 'former-file-secrets', source: 'file' },
    )
  })
})

test('adding a key to a file written before the rename keeps the former entry as it was', () => {
  withDataDir(() => {
    writeFileSync(instanceKeyFile(), JSON.stringify({ SECRETS_KEY: 'former-file-secrets' }))
    const authSecret = ensureInstanceKey('OPENCROFT_AUTH_SECRET').value
    assert.deepEqual(fileContents(), { SECRETS_KEY: 'former-file-secrets', OPENCROFT_AUTH_SECRET: authSecret })
  })
})

test('a file entry under the new name wins over one under the former name', () => {
  withDataDir(() => {
    writeFileSync(instanceKeyFile(), JSON.stringify({ SECRETS_KEY: 'former', OPENCROFT_SECRETS_KEY: 'current' }))
    assert.equal(readInstanceKey('OPENCROFT_SECRETS_KEY')?.value, 'current')
  })
})

test('with both variables set, nothing creates the key file', () => {
  withDataDir(() => {
    process.env.OPENCROFT_SECRETS_KEY = 'env-secrets'
    process.env.OPENCROFT_AUTH_SECRET = 'env-auth'
    ensureInstanceKey('OPENCROFT_SECRETS_KEY')
    ensureInstanceKey('OPENCROFT_AUTH_SECRET')
    assert.equal(existsSync(instanceKeyFile()), false)
  })
})

test('an empty environment variable counts as unset', () => {
  withDataDir(() => {
    process.env.OPENCROFT_SECRETS_KEY = ''
    assert.equal(ensureInstanceKey('OPENCROFT_SECRETS_KEY').source, 'file')
  })
})

test('reading never creates a key', () => {
  withDataDir(() => {
    assert.equal(readInstanceKey('OPENCROFT_SECRETS_KEY'), null)
    assert.deepEqual(instanceKeySources(), { OPENCROFT_SECRETS_KEY: null, OPENCROFT_AUTH_SECRET: null })
    assert.equal(existsSync(instanceKeyFile()), false)
  })
})

test('a damaged key file is refused and left as it is, without quoting it', () => {
  for (const damaged of [
    '{"OPENCROFT_SECRETS_KEY": "leakcheck',
    '["leakcheck"]',
    '{"OPENCROFT_SECRETS_KEY": 42}',
    '{"OPENCROFT_SECRETS_KEY": ""}',
    '{"SECRETS_KEY": 42}',
  ]) {
    withDataDir(() => {
      writeFileSync(instanceKeyFile(), damaged)
      assert.throws(
        () => ensureInstanceKey('OPENCROFT_AUTH_SECRET'),
        (err: Error) => {
          assert.match(err.message, /instance-secrets\.json/)
          assert.doesNotMatch(err.message, /leakcheck/, 'the message must not quote the file')
          return true
        },
        `refused: ${damaged}`,
      )
      assert.equal(readFileSync(instanceKeyFile(), 'utf8'), damaged, 'the damaged file is not replaced')
    })
  }
})

test('a key file readable by others is restricted to its owner when read', () => {
  withDataDir(() => {
    writeFileSync(instanceKeyFile(), JSON.stringify({ OPENCROFT_SECRETS_KEY: 'file-secrets' }))
    chmodSync(instanceKeyFile(), 0o644)
    readInstanceKey('OPENCROFT_SECRETS_KEY')
    assert.equal(statSync(instanceKeyFile()).mode & 0o777, 0o600)
  })
})

test('writing leaves no temporary file behind', () => {
  withDataDir((dir) => {
    ensureInstanceKey('OPENCROFT_SECRETS_KEY')
    ensureInstanceKey('OPENCROFT_AUTH_SECRET')
    assert.deepEqual(readdirSync(dir), ['instance-secrets.json'])
  })
})

test('the notice names the file and both variables by their new names, and carries no key', () => {
  withDataDir(() => {
    const { value } = ensureInstanceKey('OPENCROFT_SECRETS_KEY')
    const notice = keyFileNotice(instanceKeyFile())
    assert.ok(notice.startsWith(`Instance keys are stored in ${instanceKeyFile()} in the data volume.`))
    assert.match(notice, /set OPENCROFT_AUTH_SECRET and OPENCROFT_SECRETS_KEY from your own secret store/)
    assert.doesNotMatch(notice, /(^|[^_])(BETTER_AUTH_SECRET|SECRETS_KEY)/, 'no former name')
    assert.ok(!notice.includes(value))
  })
})
