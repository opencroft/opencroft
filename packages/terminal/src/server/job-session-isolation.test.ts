// `startJobSession` runs a command its caller chooses. Reaching it from a client message would
// therefore be arbitrary command execution by anyone holding a session cookie. What keeps that
// from happening is not that nobody has written such a case yet — it is that the module serving
// client messages does not import the module that starts jobs, and this test fails the build when
// that stops being true.
//
// A source scan rather than a type-level guarantee, for the same reason the icon-name check in the
// extension compiler is one: the property is "these two files do not meet", which is visible in the
// text, and a false positive here costs a build error while a false negative costs a shell.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const SOCKET = new URL('./socket.ts', import.meta.url)
const SERVER_DIR = new URL('./', import.meta.url)

/**
 * Every module in this directory allowed to reach the job entry point. Checking `socket.ts` alone
 * would leave the erosion path a refactor actually takes: `socket.ts` keeps a clean import list
 * while a helper it calls picks up the dependency, and both direct checks still pass. Comparing
 * the whole importer set against this list closes that — adding a name here is a deliberate act
 * with a reviewer attached, which is the point.
 */
const ALLOWED_IMPORTERS = ['index.ts', 'job-session.test.ts', 'stream-handle.test.ts']

test('the client message path does not import the job entry point', async () => {
  const source = await readFile(SOCKET, 'utf8')
  const imports = [...source.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.length > 0, 'the scan found the imports it is supposed to be checking')
  assert.ok(
    !imports.some((spec) => spec?.includes('job-session')),
    'socket.ts must not import job-session; a client message must not be able to start a job',
  )
})

test('the client message path does not import the streaming dispatch either', async () => {
  // `stream` lives on TerminalBackend, so `getBackend` now hands out the ability to start a
  // command and keep it running. socket.ts does not import that module today, and this is what
  // says so out loud: the job entry point being unreachable is worth little if the capability it
  // wraps arrives by another door. socket.ts spawns its own pty and ssh shell directly, which is
  // a client asking for a shell it is entitled to -- not a server-chosen command with a key.
  const source = await readFile(SOCKET, 'utf8')
  const imports = [...source.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.length > 0, 'the scan found the imports it is supposed to be checking')
  assert.ok(
    !imports.some((spec) => spec?.endsWith('/backend') || spec === './backend'),
    'socket.ts must not import backend; a client message must not reach the streaming dispatch',
  )
})

test('the client message path does not name the job entry point at all', async () => {
  // Covers the ways an import would not: a dynamic import, a re-export, a require.
  const source = await readFile(SOCKET, 'utf8')
  const mentions = source.split('\n').filter((line) => line.includes('startJobSession'))
  assert.deepEqual(mentions, [], 'socket.ts must not reference startJobSession')
})

test('nothing reaches the job entry point except the modules allowed to', async () => {
  const files = (await readdir(SERVER_DIR)).filter((name) => name.endsWith('.ts'))
  assert.ok(files.includes('socket.ts'), 'the scan is looking at the directory it thinks it is')

  // Module specifiers only. A substring search over the file would also match the sentences
  // explaining why socket.ts must not import this, and a check that flags its own documentation
  // is a check nobody keeps.
  const SPECIFIER =
    /(?:^\s*(?:import|export)[^\n]*?from\s+'([^']+)')|(?:\bimport\(\s*'([^']+)')|(?:\brequire\(\s*'([^']+)')/gm

  const importers: string[] = []
  for (const name of files) {
    if (name === 'job-session.ts' || name === 'job-session-isolation.test.ts') {
      continue
    }
    const source = await readFile(new URL(name, SERVER_DIR), 'utf8')
    const specifiers = [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    if (specifiers.some((spec) => spec.includes('job-session'))) {
      importers.push(name)
    }
  }

  assert.deepEqual(
    importers.sort(),
    [...ALLOWED_IMPORTERS].sort(),
    'a module started depending on job-session; if that is intended, it goes on the allow-list above and gets read as part of this change',
  )
})
