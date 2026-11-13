import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'

import { slug } from '@/app/_authed/(server)/_server/types'
import { agentPlacement, FolderMissingError, folderMissingMessage, placementOnTerminal } from './agent-placement-shared'

// The session engine and the account sign-in both place an agent through
// agentPlacement, so they agree by construction. What this file pins is that
// the placement is the one agents already had: existing workspaces and
// harness homes must not move.

const host = { cwd: '/srv/app', join: posix.join }

test('a host-run agent keeps its workspace and harness home in the data volume', () => {
  assert.deepEqual(agentPlacement({ name: 'Release Bot' }, 'node-1', host), {
    slug: 'release-bot',
    cwd: '/srv/app/data/agent-workspace/release-bot',
    harnessHome: '/srv/app/data/agent-harness-home/release-bot',
  })
})

test('an agent moved off a container (Folder /agents/<slug>) keeps the harness home it had there', () => {
  assert.deepEqual(
    agentPlacement(
      { name: 'Release Bot', terminal: 'app-1/terminal', terminalFolder: '/agents/release-bot' },
      'node-1',
      host,
    ),
    {
      slug: 'release-bot',
      cwd: '/agents/release-bot',
      harnessHome: '/agents/.harness-home/release-bot',
      terminal: 'app-1/terminal',
    },
  )
})

test('an agent whose name slugs to nothing is placed by its node id', () => {
  assert.equal(agentPlacement({}, 'node-1', host).slug, 'node-1')
  assert.equal(agentPlacement({ name: ' !! ' }, 'node-1', host).slug, 'node-1')
})

test('the slug is the one the session engine used before, so no directory moves', () => {
  for (const name of ['Release Bot', '  Ünïcode—Name  ', 'a/b\\c', 'MiXeD_case-42', '---', '']) {
    assert.equal(agentPlacement({ name }, 'node-1', host).slug, slug(name) || 'node-1', name)
  }
})

test('a terminal agent works in its Folder there, with its home beside it', () => {
  assert.deepEqual(
    agentPlacement({ name: 'Release Bot', terminal: 'box/terminal', terminalFolder: '/srv/work/' }, 'node-1', host),
    { slug: 'release-bot', cwd: '/srv/work', harnessHome: '/srv/.harness-home/release-bot', terminal: 'box/terminal' },
  )
  assert.equal(
    agentPlacement({ terminal: 'box/terminal', terminalFolder: 'work' }, 'node-1', host).harnessHome,
    './.harness-home/node-1',
  )
})

test('a terminal with no Folder is placed with none, for the terminal to name', () => {
  const placement = agentPlacement({ terminal: 'box/terminal', terminalFolder: '  ' }, 'node-1', host)
  assert.equal(placement.cwd, '')
  assert.equal(placement.terminal, 'box/terminal')
})

// A shell that runs each script with sh in `dir`, HOME set to `home`, as a
// terminal's shell starts in its own directory.
function shellIn(dir: string, home: string) {
  return async (script: string) =>
    execFileSync('sh', ['-c', script], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: home } }).toString()
}

test('an empty Folder is the directory the terminal starts in, with the harness home under its HOME', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'placement-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'work'))
  const placement = agentPlacement({ name: 'Release Bot', terminal: 'box/terminal' }, 'node-1', host)
  assert.deepEqual(await placementOnTerminal(placement, shellIn(join(root, 'work'), root), 'terminal "box"'), {
    slug: 'release-bot',
    cwd: join(root, 'work'),
    harnessHome: `${root}/.harness-home/release-bot`,
    terminal: 'box/terminal',
  })
})

test('a Folder that exists on the terminal is kept as it is', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'placement-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'it is here'))
  const placement = agentPlacement(
    { name: 'Release Bot', terminal: 'box/terminal', terminalFolder: join(root, 'it is here') },
    'node-1',
    host,
  )
  assert.deepEqual(await placementOnTerminal(placement, shellIn(root, root), 'terminal "box"'), placement)
})

test('a Folder that does not exist on the terminal is refused in plain words', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'placement-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const folder = join(root, "not 'here'")
  const placement = agentPlacement({ terminal: 'box/terminal', terminalFolder: folder }, 'node-1', host)
  await assert.rejects(placementOnTerminal(placement, shellIn(root, root), 'terminal "box"'), (error: unknown) => {
    assert.ok(error instanceof FolderMissingError)
    assert.equal(error.message, folderMissingMessage(folder, 'terminal "box"'))
    assert.match(error.message, /does not exist on terminal "box"/)
    return true
  })
  assert.equal(existsSync(folder), false)
})

test('an agent without a terminal is not asked about', async () => {
  const placement = agentPlacement({ name: 'Release Bot' }, 'node-1', host)
  const unasked = async () => assert.fail('no terminal to ask')
  assert.deepEqual(await placementOnTerminal(placement, unasked, 'nowhere'), placement)
})

test('a blank terminal is no terminal: the agent works on the server', () => {
  assert.equal(agentPlacement({ terminal: ' ' }, 'node-1', host).cwd, '/srv/app/data/agent-workspace/node-1')
})
