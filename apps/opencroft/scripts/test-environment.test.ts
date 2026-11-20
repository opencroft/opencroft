// Which of the caller's variables a test file may see (scripts/test-environment.mjs).
// That the runner hands files this environment is in run-tests.test.ts.

import assert from 'node:assert/strict'
import test from 'node:test'

import { KEPT_NAMES, KEPT_PREFIXES, testEnvironment } from '../../../scripts/test-environment.mjs'

const CASES: Array<[string, string, boolean]> = [
  ['a listed name', 'PATH', true],
  ['the scratch directory', 'TMPDIR', true],
  ['a locale variable, by prefix', 'LC_ALL', true],
  ["node's options", 'NODE_OPTIONS', true],
  ["the runner's own settings, by prefix", 'OPENCROFT_TEST_CONCURRENCY', true],
  ['a registry token node tools read', 'NODE_AUTH_TOKEN', false],
  ['a registry token in npm config', 'npm_config_//registry.example.com/:_authToken', false],
  ['an npm config file to read credentials from', 'npm_config_userconfig', false],
  ["npm's script context", 'npm_lifecycle_event', false],
  ["the caller's mode, which a test that needs one sets itself", 'NODE_ENV', false],
  ['a name that only starts with a listed one', 'NODE_OPTIONS_EXTRA', false],
  ['an askpass helper', 'GIT_ASKPASS', false],
  ['config git would add to every call', 'GIT_CONFIG_PARAMETERS', false],
  ['a repository a hook pointed git at', 'GIT_DIR', false],
  ['an ssh agent', 'SSH_AUTH_SOCK', false],
  ['a secret injected under a name nobody listed', 'alice', false],
  ['a token under a familiar name', 'GITHUB_TOKEN', false],
  ['application config outside the runner', 'OPENCROFT_DATABASE_URL', false],
  ['a tsconfig that would decide what compiles', 'TSX_TSCONFIG_PATH', false],
  ['a prefix in the wrong case', 'lc_all', false],
]

test('the caller variables a test file sees, and the ones it never does', () => {
  const inherited = Object.fromEntries(CASES.map(([, name]) => [name, `value of ${name}`]))

  const env = testEnvironment(inherited)

  for (const [what, name, kept] of CASES) {
    assert.equal(Object.hasOwn(env, name), kept, `${what} (${name}) is ${kept ? 'kept' : 'dropped'}`)
    if (kept) assert.equal(env[name], `value of ${name}`, `${name} keeps its value`)
  }
})

test('a name inherited from the prototype chain is not a listed one', () => {
  assert.deepEqual(testEnvironment({ constructor: 'x', toString: 'y' }), {})
})

test('every kept name and prefix carries its reason', () => {
  for (const [name, reason] of [...Object.entries(KEPT_NAMES), ...Object.entries(KEPT_PREFIXES)]) {
    assert.ok(reason.split(/\s+/).length >= 3, `${name}: "${reason}" says why in words`)
  }
})
