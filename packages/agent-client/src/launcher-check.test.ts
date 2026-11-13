// The probe runs in a real `sh` here, with the PATH a test gives it, so what
// is asserted is what a shell without the launcher actually answers.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { createAgentClient } from './agent-client'
import { ActionRequiredError } from './errors'
import type { ShellRunner } from './harness-process'
import {
  endpointReach,
  endpointReachMessage,
  launcherCommands,
  missingLauncherCommands,
  missingLauncherMessage,
} from './launcher-check'
import { findProvider, harnessEndpoint } from './resolve'
import type { RemoteShell } from './types'

function shellWithPath(path: string, scripts: string[] = []): ShellRunner {
  return (script) =>
    new Promise((resolve, reject) => {
      scripts.push(script)
      execFile('/bin/sh', ['-c', script], { env: { PATH: path } }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      )
    })
}

test('an npx-launched harness needs node and npx', () => {
  assert.deepEqual(launcherCommands('claude'), ['node', 'npx'])
})

test('a shell whose PATH has neither reports both missing', async () => {
  assert.deepEqual(await missingLauncherCommands(shellWithPath('/nonexistent'), 'claude'), ['node', 'npx'])
})

test('a shell whose PATH has them reports nothing missing', async () => {
  assert.deepEqual(await missingLauncherCommands(shellWithPath(process.env.PATH ?? ''), 'claude'), [])
})

test('the probe only looks the commands up', async () => {
  const scripts: string[] = []
  await missingLauncherCommands(shellWithPath('/nonexistent', scripts), 'claude')
  assert.equal(scripts.length, 1)
  assert.match(scripts[0] ?? '', /^for c in 'node' 'npx'; do command -v "\$c" >\/dev\/null 2>&1 \|\| echo "\$c"; done$/)
})

test('a session through a shell without Node.js is refused with the reason, and the harness is never started', async () => {
  const started: string[][] = []
  const shell: RemoteShell = {
    id: 'box/terminal',
    async spawn(argv, env) {
      started.push(argv)
      const [command, ...args] = argv
      // The shell itself is there; its PATH holds nothing else.
      const program = command === 'sh' ? '/bin/sh' : command
      return spawn(program, args, { env: { ...env, PATH: '/nonexistent' }, stdio: ['pipe', 'pipe', 'pipe'] })
    },
    mcpUrl: (url) => url,
    describe: async () => 'terminal "Build server"',
  }
  const client = createAgentClient({ shells: (id) => (id === shell.id ? shell : undefined) })
  await assert.rejects(
    client.createSession({
      providerId: 'anthropic',
      adapterId: 'claude',
      model: '',
      apiKey: '',
      cwd: '/work/agent',
      shell: shell.id,
    }),
    (error: Error) =>
      error instanceof ActionRequiredError &&
      error.message === missingLauncherMessage(['node', 'npx'], 'terminal "Build server"'),
  )
  assert.equal(started.length, 1, 'only the probe ran')
  assert.match(started[0]?.[2] ?? '', /^for c in /)
})

test('an endpoint that answers, even with 401, is reachable; nothing secret is on the probe', async () => {
  const server = createServer((req, res) => {
    res.statusCode = req.headers.authorization ? 500 : 401
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/v1`
    const scripts: string[] = []
    const reach = await endpointReach(shellWithPath(process.env.PATH ?? '', scripts), url)
    assert.deepEqual(reach, { reachable: true, status: 401 }, 'answered without credentials')
    assert.match(scripts[0] ?? '', /^node -e '/)
    assert.equal(endpointReachMessage(url, reach, 'this terminal'), `The model endpoint ${url} is reachable from this terminal.`)
  } finally {
    server.close()
  }
})

test('an endpoint nobody listens on is unreachable, with the reason', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  const url = `http://127.0.0.1:${port}/v1`
  const reach = await endpointReach(shellWithPath(process.env.PATH ?? ''), url)
  assert.deepEqual(reach, { reachable: false, reason: 'ECONNREFUSED' })
  assert.equal(
    endpointReachMessage(url, reach, 'this terminal'),
    `The model endpoint ${url} can't be reached from this terminal (ECONNREFUSED).`,
  )
})

test('the endpoint is the one the harness is pointed at, and none for a harness pointed nowhere', () => {
  assert.equal(
    harnessEndpoint({ adapterId: 'claude', providerId: 'anthropic', baseUrl: 'http://10.0.0.7:8090' }),
    'http://10.0.0.7:8090',
  )
  // The provider leaves the endpoint to the harness's own default: none is known to check.
  assert.equal(findProvider('anthropic')?.endpoints.anthropic, '')
  assert.equal(harnessEndpoint({ adapterId: 'claude', providerId: 'anthropic' }), undefined)
  assert.equal(harnessEndpoint({ adapterId: 'claude-subscription', providerId: 'anthropic' }), undefined)
  assert.equal(harnessEndpoint({ adapterId: 'native', providerId: 'anthropic', baseUrl: 'http://10.0.0.7:8090' }), undefined)
})

test('a missing Node.js is named as such, with where and what to do', () => {
  assert.equal(
    missingLauncherMessage(['npx'], 'terminal "Build server"'),
    'Node.js (npx) isn\'t available in terminal "Build server"; install it there or put it on the non-interactive PATH.',
  )
})
