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
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SOCKET = new URL('./socket.ts', import.meta.url)

test('the client message path does not import the job entry point', async () => {
  const source = await readFile(SOCKET, 'utf8')
  const imports = [...source.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.length > 0, 'the scan found the imports it is supposed to be checking')
  assert.ok(
    !imports.some((spec) => spec?.includes('job-session')),
    'socket.ts must not import job-session; a client message must not be able to start a job',
  )
})

test('the client message path does not name the job entry point at all', async () => {
  // Covers the ways an import would not: a dynamic import, a re-export, a require.
  const source = await readFile(SOCKET, 'utf8')
  const mentions = source.split('\n').filter((line) => line.includes('startJobSession'))
  assert.deepEqual(mentions, [], 'socket.ts must not reference startJobSession')
})
