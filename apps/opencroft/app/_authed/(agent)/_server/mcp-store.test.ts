// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env for how this stays off the shared dev/production database. A caller's
// own MCP Connection node must be surfaced without a global entry, and only to
// that caller.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentSelection } from 'agent-client/types'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { isConnectionNodeName, readMcpServersForAgent, writeMcpServers } from './mcp-store'

function selectionWithIdentity(mcpIdentity?: string): AgentSelection {
  return {
    providerId: '',
    adapterId: 'claude',
    model: '',
    apiKey: '',
    cwd: '/tmp',
    mcpIdentity,
  }
}

async function spaceWithConnectionNode(name: string) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `mcp-store-test-${crypto.randomUUID()}`
  const space = await registry.create(slug, slug, { nodes: [], edges: [] })
  await registry.saveGraph(space.slug, {
    nodes: [
      {
        id: 'conn-1',
        type: 'mcp-connection',
        position: { x: 0, y: 0 },
        data: { name, transport: 'sse', url: `https://example.test/${name}`, headers: [], env: [] },
      },
    ],
    edges: [],
  })
  return space
}

test('readMcpServersForAgent returns only the global list when the selection carries no mcpIdentity', async () => {
  await writeMcpServers([{ name: 'shared-team-server', transport: 'http', url: 'https://example.test/shared' }])
  const servers = await readMcpServersForAgent(selectionWithIdentity(undefined))
  assert.deepEqual(
    servers.map((s) => s.name),
    ['shared-team-server'],
  )
})

test("readMcpServersForAgent surfaces the caller's own MCP Connection node without a global entry", async () => {
  await writeMcpServers([])
  await spaceWithConnectionNode('openproject-mcp-test-owner')
  const servers = await readMcpServersForAgent(selectionWithIdentity('test-owner'))
  assert.deepEqual(
    servers.map((s) => s.name),
    ['openproject-mcp-test-owner'],
  )
})

test('readMcpServersForAgent does not surface a connection node belonging to a different identity', async () => {
  await writeMcpServers([])
  await spaceWithConnectionNode('openproject-mcp-someone-else')
  const servers = await readMcpServersForAgent(selectionWithIdentity('test-owner-2'))
  assert.deepEqual(servers, [])
})

test('readMcpServersForAgent merges owned and global entries, owned winning on a name collision', async () => {
  await writeMcpServers([
    { name: 'shared-team-server', transport: 'http', url: 'https://example.test/shared' },
    { name: 'mcp-test-owner-3', transport: 'http', url: 'https://stale.example.test' },
  ])
  await spaceWithConnectionNode('mcp-test-owner-3')
  const servers = await readMcpServersForAgent(selectionWithIdentity('test-owner-3'))
  assert.deepEqual(
    servers.map((s) => s.name).sort(),
    ['mcp-test-owner-3', 'shared-team-server'].sort(),
  )
  const owned = servers.find((s) => s.name === 'mcp-test-owner-3')
  assert.equal(
    owned?.url,
    'https://example.test/mcp-test-owner-3',
    "the node's own config must win, not the stale global one",
  )
})

test('isConnectionNodeName is true for a name an MCP Connection node already claims, false otherwise', async () => {
  await spaceWithConnectionNode('openproject-mcp-test-owner-4')
  assert.equal(await isConnectionNodeName('openproject-mcp-test-owner-4'), true)
  assert.equal(await isConnectionNodeName('openproject-mcp-nobody-claims-this'), false)
})
