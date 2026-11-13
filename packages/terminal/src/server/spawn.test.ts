// `spawn` is for a caller that talks to a process for as long as it runs, so what these assert is
// a conversation: a line written, its answer read, and then another, over one stdin that stays
// open. Real processes through the real local backend, and through the stand-in `docker` for
// docker-exec, where env travels as lines on that same stdin.
import assert from 'node:assert/strict'
import type { Readable } from 'node:stream'
import test from 'node:test'

import type { TerminalContext } from '../types'
import { getBackend, type SpawnedProcess } from './backend'
import { DOCKER_EXEC, withFakeDocker } from './test-fake-docker'

const LOCAL: TerminalContext = { type: 'local' } as TerminalContext

// Answers every line it reads, prefixed with the variable it was given.
const ECHO_LINES = ['sh', '-c', 'while IFS= read -r l; do echo "$GREETING:$l"; done']

function lineReader(stream: Readable): () => Promise<string> {
  let buffered = ''
  const waiting: ((line: string) => void)[] = []
  const lines: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffered += chunk
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      const next = waiting.shift()
      if (next) {
        next(line)
      } else {
        lines.push(line)
      }
    }
  })
  return () => {
    const line = lines.shift()
    return line !== undefined ? Promise.resolve(line) : new Promise((resolve) => waiting.push(resolve))
  }
}

function exitOf(child: SpawnedProcess): Promise<[number | null, string | null]> {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve([code, signal])))
}

function errorOf(child: SpawnedProcess): Promise<Error> {
  return new Promise((resolve) => child.on('error', resolve))
}

async function converse(child: SpawnedProcess): Promise<void> {
  const next = lineReader(child.stdout)
  child.stdin.write('one\n')
  assert.equal(await next(), 'hi:one')
  child.stdin.write('two\n')
  assert.equal(await next(), 'hi:two', 'stdin is still open after the first answer')
  const exited = exitOf(child)
  child.stdin.end()
  const [code] = await exited
  assert.equal(code, 0)
  assert.equal(child.exitCode, 0)
}

test('a local process keeps its stdin open and takes its env', async () => {
  const child = await getBackend(LOCAL).spawn(LOCAL, ECHO_LINES, { env: { GREETING: 'hi' } })
  await converse(child)
})

test('a docker-exec process takes its env off stdin and then reads the caller’s lines', async () => {
  await withFakeDocker(async () => {
    const child = await getBackend(DOCKER_EXEC).spawn(DOCKER_EXEC, ECHO_LINES, { env: { GREETING: 'hi' } })
    await converse(child)
  })
})

test('a value given as env reaches a docker-exec process without being in its argv', async () => {
  await withFakeDocker(async () => {
    const child = await getBackend(DOCKER_EXEC).spawn(
      DOCKER_EXEC,
      ['sh', '-c', 'tr "\\0" " " < /proc/$$/cmdline; echo; echo "$GREETING"'],
      { env: { GREETING: 'S3CRET-ENV-VALUE' } },
    )
    const next = lineReader(child.stdout)
    const argv = await next()
    assert.equal(await next(), 'S3CRET-ENV-VALUE', 'the value reached the process')
    assert.ok(!argv.includes('S3CRET-ENV-VALUE'), `argv carries no value: ${argv}`)
    child.stdin.end()
    await exitOf(child)
  })
})

test('kill stops a process that is still reading', async () => {
  const child = await getBackend(LOCAL).spawn(LOCAL, ['cat'])
  const exited = exitOf(child)
  child.kill()
  const [code, signal] = await exited
  assert.equal(code, null)
  assert.equal(signal, 'SIGTERM')
})

test('a command that cannot start reports an error', async () => {
  const child = await getBackend(LOCAL).spawn(LOCAL, ['no-such-command-anywhere'])
  assert.match((await errorOf(child)).message, /ENOENT/)
})
