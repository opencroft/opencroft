// Every place the app's source deletes one secret by name. The check that
// refuses a secret a node still names (`deleteSecretChecked`) holds only while
// nothing deletes around it, so a second caller of the store's delete fails
// here until it goes through that check.
//
// What this cannot see: a call through the store under another name (an
// aliased import such as `secrets as store`), and an extension outside this
// repository calling `secrets.delete` from `@opencroft/server/secrets`, which
// the host gives every extension unchecked.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/** `apps/opencroft`, the root every path below is relative to. */
const APP_ROOT = path.resolve(import.meta.dirname, '../../../..')

/** The source trees the app is built from, as the workspace's test script lists them. */
const SOURCE_DIRS = ['app', 'server', 'components', 'scripts']

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.output'])

/** The one delete of a secret by name: the store's `remove` inside the core extension's checked delete. */
const CHECKED_DELETE_FILE = 'app/_authed/(extension-runtime)/_builtin/core/server/secrets-store.ts'

const STORE_DELETE_CALL = /\bsecrets\s*\.\s*delete\s*\(/g

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(path.join(APP_ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...sourceFiles(relative))
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(relative)
    }
  }
  return files
}

function storeDeleteCalls(file: string): number {
  return readFileSync(path.join(APP_ROOT, file), 'utf8').match(STORE_DELETE_CALL)?.length ?? 0
}

test('the store deletes a secret by name in one place in the app source', () => {
  const callers = SOURCE_DIRS.flatMap(sourceFiles).filter((file) => storeDeleteCalls(file) > 0)
  assert.deepEqual(callers, [CHECKED_DELETE_FILE])
  assert.equal(storeDeleteCalls(CHECKED_DELETE_FILE), 1)
})

test('that one delete is the removal the checked delete runs after its checks', () => {
  const source = readFileSync(path.join(APP_ROOT, CHECKED_DELETE_FILE), 'utf8')
  assert.match(source, /deleteSecretChecked\(\s*name,\s*override,\s*\{[^}]*remove:\s*\(\)\s*=>\s*secrets\.delete\(/)
})

// A rename takes the old name away from whatever names it, so it holds to the
// same check (`renameSecretChecked`) and the same single caller.
const STORE_RENAME_CALL = /\bsecrets\s*\.\s*rename\s*\(/g

function storeRenameCalls(file: string): number {
  return readFileSync(path.join(APP_ROOT, file), 'utf8').match(STORE_RENAME_CALL)?.length ?? 0
}

test('the store renames a secret in one place in the app source, inside the checked rename', () => {
  const callers = SOURCE_DIRS.flatMap(sourceFiles).filter((file) => storeRenameCalls(file) > 0)
  assert.deepEqual(callers, [CHECKED_DELETE_FILE])
  assert.equal(storeRenameCalls(CHECKED_DELETE_FILE), 1)
  const source = readFileSync(path.join(APP_ROOT, CHECKED_DELETE_FILE), 'utf8')
  assert.match(
    source,
    /renameSecretChecked\(\s*from,\s*to,\s*override,\s*\{[^}]*rename:\s*\(key\)\s*=>\s*secrets\.rename\(/,
  )
})
