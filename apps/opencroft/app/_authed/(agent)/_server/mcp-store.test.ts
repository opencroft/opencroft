// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env for how this stays off the shared dev/production database.
// readMcpServersForAgent used to auto-forward a caller's own MCP Connection
// node into its session; that mount rode a long-lived MCP client connection
// that kept rotting with nothing able to heal it, so it was
// removed -- readMcpServersForAgent is now just the global list, regardless
// of mcpIdentity or what MCP Connection nodes exist. isConnectionNodeName
// (a separate concern: keeping a personal credential off the global list,
// a rule of its own) is unaffected and still pinned below.
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
  return registry.create(slug, slug, {
    nodes: [
      {
        id: 'conn-1',
        // Whichever owner the providing extension is installed under.
        type: 'acme.mcp.mcp-connection',
        position: { x: 0, y: 0 },
        data: { name, transport: 'sse', url: `https://example.test/${name}`, headers: [], env: [] },
      },
    ],
    edges: [],
  })
}

test('readMcpServersForAgent returns only the global list when the selection carries no mcpIdentity', async () => {
  await writeMcpServers([{ name: 'shared-team-server', transport: 'http', url: 'https://example.test/shared' }])
  const servers = await readMcpServersForAgent(selectionWithIdentity(undefined))
  assert.deepEqual(
    servers.map((s) => s.name),
    ['shared-team-server'],
  )
})

test('readMcpServersForAgent does not forward a matching MCP Connection node even when the selection carries an mcpIdentity', async () => {
  // Pins the removal itself: this exact setup (global list + an owned-shaped
  // node + a matching identity) used to merge the node in. It must not
  // anymore -- the global list, unchanged, is the whole answer regardless of
  // mcpIdentity.
  await writeMcpServers([{ name: 'shared-team-server', transport: 'http', url: 'https://example.test/shared' }])
  await spaceWithConnectionNode('openproject-mcp-test-owner')
  const servers = await readMcpServersForAgent(selectionWithIdentity('test-owner'))
  assert.deepEqual(
    servers.map((s) => s.name),
    ['shared-team-server'],
  )
})

test('isConnectionNodeName is true for a name an MCP Connection node already claims, false otherwise', async () => {
  await spaceWithConnectionNode('openproject-mcp-test-owner-4')
  assert.equal(await isConnectionNodeName('openproject-mcp-test-owner-4'), true)
  assert.equal(await isConnectionNodeName('openproject-mcp-nobody-claims-this'), false)
})
