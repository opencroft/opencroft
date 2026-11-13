// The session gate's decision, asked about every server function in the tree:
// the app's own and those `packages/*` define. A server function cannot be
// invoked outside the server runtime's request context, so this drives the
// decision the gate makes for each one (`admitServerFnCall`) with the identity
// the compiler gives the gate, `{ name, filename }`, filename relative to the
// app root. That the gate is registered for every server function is pinned
// below through `app/start.ts`; the 401 over HTTP itself is not exercised
// here.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'

import {
  admitServerFnCall,
  isPublicServerFn,
  PUBLIC_SERVER_FNS,
  type ServerFnIdentity,
} from '@/app/_server/server-fn-access'

const APP_ROOT = resolve(import.meta.dirname, '../..')
const REPO_ROOT = resolve(APP_ROOT, '../..')

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
      continue
    }
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full)
    }
  }
  return found
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// The compiler accepts a server function only when it is assigned to a
// variable, exported or not; that variable is the `name` the gate is given.
const SERVER_FN = /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*createServerFn\b/gm

function serverFnsIn(files: string[]): ServerFnIdentity[] {
  return files.flatMap((file) =>
    [...stripComments(readFileSync(file, 'utf8')).matchAll(SERVER_FN)].map((m) => ({
      name: m[1],
      filename: relative(APP_ROOT, file),
    })),
  )
}

// A file whose code calls `createServerFn` but gives the walk no function holds
// a server function in a shape `SERVER_FN` does not read.
const CALLS_SERVER_FN = /\bcreateServerFn\s*(?:<[^>]*>\s*)?\(/

function filesTheWalkMisses(files: string[], fns: ServerFnIdentity[]): string[] {
  const walked = new Set(fns.map((fn) => fn.filename))
  return files
    .filter((file) => CALLS_SERVER_FN.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(APP_ROOT, file))
    .filter((filename) => !walked.has(filename))
}

const FILES = [...sourceFiles(join(APP_ROOT, 'app')), ...sourceFiles(join(REPO_ROOT, 'packages'))]
const ALL = serverFnsIn(FILES)
const label = (fn: ServerFnIdentity) => `${fn.filename}#${fn.name}`
const anonymous = async () => false
const signedIn = async () => true

test('the walk finds the server functions the gate is about', () => {
  const found = new Set(ALL.map(label))
  for (const known of [
    'app/_authed/(secrets-store)/_server/actions.ts#getSecrets',
    'app/_authed/(approvals)/_server/actions.ts#readRemoteFile',
    'app/_authed/(approvals)/_server/actions.ts#setAutoApprove',
    'app/_authed/(settings)/_server/backup-actions.ts#restoreBackupNow',
    // Not exported: wrapped before export, still an endpoint.
    '../../packages/agent-chat/src/server/actions.ts#_getMcpServers',
  ]) {
    assert.ok(found.has(known), `expected the walk to find ${known}`)
  }
})

test('every scanned file that calls createServerFn gives the walk a server function', () => {
  assert.deepEqual(filesTheWalkMisses(FILES, ALL), [])
})

test('a file the walk skips is named by the check', () => {
  const skipped = 'app/_authed/(secrets-store)/_server/actions.ts'
  assert.deepEqual(
    filesTheWalkMisses(
      FILES,
      ALL.filter((fn) => fn.filename !== skipped),
    ),
    [skipped],
  )
})

test('every function on the public list is a server function in the tree', () => {
  const found = new Set(ALL.map(label))
  const listed = Object.entries(PUBLIC_SERVER_FNS).flatMap(([filename, names]) =>
    names.map((name) => `${filename}#${name}`),
  )
  assert.deepEqual(
    listed.filter((entry) => !found.has(entry)),
    [],
    'listed as public but not found: renamed or removed, so the entry opens nothing and should go',
  )
})

test('an anonymous call to any server function off the public list is refused with 401', async () => {
  const admitted: string[] = []
  for (const fn of ALL.filter((f) => !isPublicServerFn(f))) {
    try {
      await admitServerFnCall(fn, anonymous)
      admitted.push(label(fn))
    } catch (refusal) {
      assert.ok(refusal instanceof Response, `${label(fn)} threw something other than a Response`)
      assert.equal(refusal.status, 401, label(fn))
    }
  }
  assert.deepEqual(admitted, [])
})

test('a signed-in call to every server function is admitted', async () => {
  for (const fn of ALL) {
    await admitServerFnCall(fn, signedIn)
  }
})

test('the public functions answer an anonymous caller without a session lookup', async () => {
  const publicFns = ALL.filter(isPublicServerFn)
  assert.deepEqual(publicFns.map(label).sort(), [
    'app/(auth)/_server/session.ts#getAuthState',
    'app/(auth)/_server/session.ts#getSocialProviders',
    'app/(auth)/_server/setup.ts#completeSetup',
    'app/(auth)/_server/setup.ts#getSetupStatus',
    'app/_server/brand-color-actions.ts#getBrandColor',
  ])
  for (const fn of publicFns) {
    await admitServerFnCall(fn, async () => assert.fail(`${label(fn)} asked for a session`))
  }
})

test('a call the compiler gave no identity is refused anonymously', async () => {
  await assert.rejects(admitServerFnCall(undefined, anonymous), (r) => r instanceof Response && r.status === 401)
})

test('a public name in another file, or a prototype key as the file, is not public', () => {
  assert.equal(isPublicServerFn({ filename: 'app/_authed/(x)/_server/actions.ts', name: 'getAuthState' }), false)
  assert.equal(isPublicServerFn({ filename: 'constructor', name: 'getAuthState' }), false)
  assert.equal(isPublicServerFn({ filename: '__proto__', name: 'getAuthState' }), false)
})
