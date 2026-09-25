import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'

import { slug } from '@/app/_authed/(server)/_server/types'
import { agentPlacement } from './agent-placement-shared'

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

test('a container agent is placed under /agents inside the container', () => {
  assert.deepEqual(agentPlacement({ name: 'Release Bot', containerName: 'agents' }, 'node-1', host), {
    slug: 'release-bot',
    cwd: '/agents/release-bot',
    harnessHome: '/agents/.harness-home/release-bot',
    containerName: 'agents',
  })
  assert.equal(agentPlacement({ name: 'a', containerName: '' }, 'node-1', host).containerName, undefined)
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
