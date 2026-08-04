// Verifies the actual leak this guards: an injected env value must never appear in the spawned
// process's own argv, for as long as it runs -- checked by reading its live /proc/<pid>/cmdline
// while it's still alive, the same interface `ps aux`/`pgrep -fa` read from. Real observation of
// a running process, not a re-reading of the source that produces it. Uses synthetic test data
// only, never a real credential.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildEnvInjection } from './exec-util'

test('buildEnvInjection: preamble carries only names, stdin carries the values', () => {
  const { preamble, stdin } = buildEnvInjection({ FOO: 'value-one', BAR: 'value-two' })
  assert.ok(preamble.includes('FOO'))
  assert.ok(preamble.includes('BAR'))
  assert.ok(!preamble.includes('value-one'))
  assert.ok(!preamble.includes('value-two'))
  assert.ok(!preamble.includes(Buffer.from('value-one', 'utf8').toString('base64')))
  assert.ok(stdin)
  const lines = (stdin ?? Buffer.alloc(0)).toString('utf8').split('\n').filter(Boolean)
  assert.deepEqual(
    lines.map((l) => Buffer.from(l, 'base64').toString('utf8')),
    ['value-one', 'value-two'],
  )
})

test('buildEnvInjection: empty/undefined env yields no preamble and no stdin', () => {
  assert.deepEqual(buildEnvInjection(undefined), { preamble: '', stdin: undefined })
  assert.deepEqual(buildEnvInjection({}), { preamble: '', stdin: undefined })
})

test('buildEnvInjection: a value containing a trailing newline round-trips through the preamble unchanged apart from that trailing newline (matches the prior $() semantics, not a new corruption)', () => {
  const { stdin } = buildEnvInjection({ K: 'line-one\nline-two\n' })
  assert.ok(stdin)
  const [line] = (stdin ?? Buffer.alloc(0)).toString('utf8').split('\n').filter(Boolean)
  assert.equal(Buffer.from(line, 'base64').toString('utf8'), 'line-one\nline-two\n')
})

test("an injected value never appears in the spawned process's own argv while it runs, observed via /proc/<pid>/cmdline -- the actual leak, not inferred from source", async () => {
  const secretValue = `synthetic-${Math.random().toString(36).slice(2)}-not-a-real-credential`
  const { preamble, stdin } = buildEnvInjection({ CAROL_TEST_SECRET: secretValue })
  // Mirrors exactly what sshBackend/dockerExecBackend/wslBackend build: one `sh -c` argv element
  // holding the preamble (names only) plus the caller's command, values delivered over stdin.
  const command = `${preamble}sleep 2; printf 'value-was-set:%s' "$CAROL_TEST_SECRET"`
  const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
  assert.ok(child.pid, 'process must have spawned to observe it')
  child.stdin?.end(stdin)

  // Real observation while the process is alive -- /proc/<pid>/cmdline is the same interface
  // `ps`/`pgrep -fa` read from. A value that leaked into argv, encoded or not, would appear here.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const cmdline = (await readFile(`/proc/${child.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ')
  assert.ok(!cmdline.includes(secretValue), 'raw value must not appear in argv')
  assert.ok(
    !cmdline.includes(Buffer.from(secretValue, 'utf8').toString('base64')),
    'base64 of the value must not appear in argv either -- encoding it differently is not a fix',
  )
  assert.ok(cmdline.includes('CAROL_TEST_SECRET'), 'the NAME is expected to be visible -- only the value is the defect')

  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  await new Promise((resolve) => child.on('close', resolve))
  assert.equal(
    stdout,
    `value-was-set:${secretValue}`,
    'the value must still reach the command correctly, just not via argv',
  )
})
