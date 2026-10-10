import assert from 'node:assert/strict'
import test from 'node:test'

import { RENAMED_ENV, readEnv } from './env'

// readEnv reports each name once per process, so every test reads a name no
// other test in this file reads.

function captureWarnings(t: test.TestContext): string[] {
  const lines: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    lines.push(args.join(' '))
  })
  return lines
}

test('every renamed variable is OPENCROFT_*, and no former name is one', () => {
  for (const [current, former] of Object.entries(RENAMED_ENV)) {
    assert.match(current, /^OPENCROFT_[A-Z0-9_]+$/)
    assert.doesNotMatch(former, /^OPENCROFT_/)
  }
  assert.equal(RENAMED_ENV.OPENCROFT_SECRETS_KEY, 'SECRETS_KEY')
  assert.equal(RENAMED_ENV.OPENCROFT_AUTH_SECRET, 'BETTER_AUTH_SECRET')
})

test('only the new name set: its value, and nothing logged', (t) => {
  const warnings = captureWarnings(t)
  const env = { OPENCROFT_EXTENSIONS: 'new-value-a' }
  assert.equal(readEnv('OPENCROFT_EXTENSIONS', env), 'new-value-a')
  assert.deepEqual(warnings, [])
})

test('only the former name set: its value, and one deprecation line naming both names but no value', (t) => {
  const warnings = captureWarnings(t)
  const env = { DATABASE_URL: 'old-value-leakcheck' }
  assert.equal(readEnv('OPENCROFT_DATABASE_URL', env), 'old-value-leakcheck')
  assert.equal(readEnv('OPENCROFT_DATABASE_URL', env), 'old-value-leakcheck', 'a second read gives the same value')
  assert.equal(warnings.length, 1, 'reported once, however often it is read')
  assert.match(warnings[0], /DATABASE_URL is deprecated/)
  assert.match(warnings[0], /OPENCROFT_DATABASE_URL/)
  assert.doesNotMatch(warnings[0], /leakcheck/)
})

test('both names set: the new one wins, and the log says so once, with no value', (t) => {
  const warnings = captureWarnings(t)
  const env = { OPENCROFT_PGLITE_PATH: 'new-leakcheck', PGLITE_PATH: 'old-leakcheck' }
  assert.equal(readEnv('OPENCROFT_PGLITE_PATH', env), 'new-leakcheck')
  assert.equal(readEnv('OPENCROFT_PGLITE_PATH', env), 'new-leakcheck')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Both OPENCROFT_PGLITE_PATH and PGLITE_PATH are set: using OPENCROFT_PGLITE_PATH/)
  assert.doesNotMatch(warnings[0], /leakcheck/)
})

test('neither set: undefined, and nothing logged', (t) => {
  const warnings = captureWarnings(t)
  assert.equal(readEnv('OPENCROFT_EXTENSION_REGISTRIES', {}), undefined)
  assert.deepEqual(warnings, [])
})

test('an empty value counts as unset under either name', (t) => {
  const warnings = captureWarnings(t)
  assert.equal(
    readEnv('OPENCROFT_GOOGLE_CLIENT_ID', { OPENCROFT_GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_ID: 'old' }),
    'old',
  )
  assert.equal(readEnv('OPENCROFT_APPLE_CLIENT_ID', { APPLE_CLIENT_ID: '' }), undefined)
  assert.equal(warnings.length, 1, 'only the non-empty former name is reported')
  assert.match(warnings[0], /GOOGLE_CLIENT_ID is deprecated/)
})

test('process.env is read when no environment is passed', (t) => {
  const warnings = captureWarnings(t)
  const saved = process.env.OPENCROFT_DB_MIGRATIONS_DIR
  process.env.OPENCROFT_DB_MIGRATIONS_DIR = 'from-process-env'
  try {
    assert.equal(readEnv('OPENCROFT_DB_MIGRATIONS_DIR'), 'from-process-env')
  } finally {
    if (saved === undefined) {
      delete process.env.OPENCROFT_DB_MIGRATIONS_DIR
    } else {
      process.env.OPENCROFT_DB_MIGRATIONS_DIR = saved
    }
  }
  assert.deepEqual(warnings, [])
})
