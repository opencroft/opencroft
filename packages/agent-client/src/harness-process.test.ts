// A selection naming a shell runs its harness, and reads and writes its
// instruction files, through the host's shell of that id and nowhere else.
// The shell here is a stand-in that starts what it is given on this machine
// and records it, so what is asserted is what a real shell would be handed
// and what it answered.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { dockerExecShell, localShell, startHarnessProcess } from './harness-process'
import { fileAccessFor, writeInstructionFiles } from './instruction-files'
import { createMcpServer, MCP_FORWARDED_HEADER } from './mcp-server'
import { buildSpawnConfig, harnessPlacement } from './resolve'
import type { AgentSelection, HarnessProcess, RemoteShell, ShellResolver } from './types'

interface RecordingShell extends RemoteShell {
  started: { argv: string[]; env: Record<string, string> }[]
}

function recordingShell(id: string): RecordingShell {
  const started: RecordingShell['started'] = []
  return {
    id,
    started,
    async spawn(argv, env) {
      started.push({ argv, env })
      const [command, ...args] = argv
      return spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    },
    mcpUrl: (url) => url.replace('127.0.0.1', 'far.example'),
  }
}

function resolverOf(shell: RemoteShell): ShellResolver {
  return (id) => (id === shell.id ? shell : undefined)
}

function selection(over: Partial<AgentSelection>): AgentSelection {
  return { providerId: 'anthropic', adapterId: 'claude', model: '', apiKey: 'sk-test-0123456789', cwd: '', ...over }
}

test('a shell wins over a container name as the place a harness runs', () => {
  assert.deepEqual(harnessPlacement({ shell: 'box/terminal', containerName: 'agents' }), {
    kind: 'shell',
    shell: 'box/terminal',
  })
  assert.deepEqual(harnessPlacement({ containerName: 'agents' }), { kind: 'container', container: 'agents' })
  assert.deepEqual(harnessPlacement({}), { kind: 'host' })
})

test('a shell spawn enters its folder there and carries its env apart from the command line', () => {
  const config = buildSpawnConfig(selection({ shell: 'box/terminal', containerName: 'ignored', cwd: '/work/agent' }))
  assert.equal(config.shell, 'box/terminal')
  assert.equal(config.command, 'sh', 'started by the shell there, not by docker here')
  assert.match(config.args[1] ?? '', /mkdir -p '\/work\/agent' && cd '\/work\/agent'/)
  assert.ok(!config.args.includes('docker') && !config.args.includes('ignored'), 'the container name plays no part')
  assert.ok(Object.values(config.env).includes('sk-test-0123456789'), 'the key travels in the env')
  assert.ok(!config.args.join(' ').includes('sk-test-0123456789'), 'the key is not in the command line')
})

test('a shell spawn is started by the shell its id names, with its env', async () => {
  const shell = recordingShell('box/terminal')
  const config = { command: 'sh', args: ['-c', 'echo "$GREETING"'], cwd: '', env: { GREETING: 'hi' }, shell: shell.id }
  const child: HarnessProcess = await startHarnessProcess(config, resolverOf(shell))
  const out: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  await new Promise((resolve) => child.stdout.on('end', resolve))
  assert.equal(Buffer.concat(out).toString().trim(), 'hi')
  assert.deepEqual(shell.started[0]?.env, { GREETING: 'hi' })
})

test('a shell spawn the host has no shell for is refused rather than started here', async () => {
  const config = { command: 'sh', args: [], cwd: '', env: {}, shell: 'box/terminal' }
  await assert.rejects(startHarnessProcess(config, undefined), /The shell 'box\/terminal'/)
  await assert.rejects(startHarnessProcess(config, resolverOf(recordingShell('other/terminal'))), /not known/)
})

test('instruction files of a shell agent are written through its shell, in its folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shell-files-'))
  try {
    const shell = recordingShell('box/terminal')
    const chosen = selection({ shell: shell.id, cwd: join(dir, 'work'), harnessHome: join(dir, 'home') })
    const access = fileAccessFor(chosen, resolverOf(shell))
    const sync = await writeInstructionFiles(chosen, { agent: 'Be brief.' }, 'sidecar line', access)
    assert.deepEqual(sync?.problems, [])
    assert.equal((await readFile(join(dir, 'work', 'CLAUDE.md'), 'utf8')).trim(), 'Be brief.')
    assert.ok(shell.started.length > 0, 'the files were reached through the shell')
    assert.ok(
      shell.started.every(({ argv }) => argv[0] === 'sh' && argv[1] === '-c'),
      'every file operation went through the shell',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the ready local shell runs a harness here, through the same path a named shell takes', async () => {
  const shell = localShell()
  const config = { command: 'sh', args: ['-c', 'echo "$GREETING"'], cwd: '', env: { GREETING: 'here' }, shell: shell.id }
  const child = await startHarnessProcess(config, resolverOf(shell))
  const out: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  await new Promise((resolve) => child.stdout.on('end', resolve))
  assert.equal(Buffer.concat(out).toString().trim(), 'here')
  assert.equal(shell.mcpUrl('http://127.0.0.1:1/mcp'), 'http://127.0.0.1:1/mcp', 'this machine reaches its loopback')
})

test('the ready docker shell names its container and forwards env by name only', () => {
  const shell = dockerExecShell('agents-box')
  assert.equal(shell.id, 'docker:agents-box')
  assert.notEqual(shell.mcpUrl('http://127.0.0.1:1/mcp'), 'http://127.0.0.1:1/mcp', 'a sibling container gets another host')
})

test('a relayed request is held to the rule for an outside caller', async () => {
  const handle = createMcpServer({ name: `relayed-${crypto.randomUUID()}`, tools: [], skills: [] })
  try {
    const url = await handle.ensureUrl()
    const ask = (headers: Record<string, string>) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    assert.notEqual((await ask({})).status, 403, 'a loopback caller is served')
    assert.equal((await ask({ [MCP_FORWARDED_HEADER]: '1' })).status, 403, 'the same call relayed is refused')
  } finally {
    await handle.close()
  }
})
