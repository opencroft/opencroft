// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env for how this stays off the shared dev/production database.
// readMcpServersForAgent is the global list as one agent's session mounts it:
// never an MCP Connection node, with the secrets the list names resolved for
// that agent. isConnectionNodeName keeps a personal credential off the global
// list, a rule of its own.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpServerConfig } from 'agent-client/mcp-types'
import type { AgentSelection } from 'agent-client/types'

import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { secrets } from '@/server/secrets'
import { isConnectionNodeName, readMcpServersForAgent, resolveMcpServerSecrets, writeMcpServers } from './mcp-store'

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

// An agent and a Secrets Store holding `stored` on one graph, as a person sets
// them up: the store's rows are keyed by its node's id.
async function agentWithSecrets(
  stored: Record<string, string>,
): Promise<{ nodeId: string; identity: string; storeId: string }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const id = crypto.randomUUID()
  const name = `MCP Store Agent ${id}`
  const nodeId = `agent-${id}`
  const storeId = `store-${id}`
  await registry.create(`mcp-store-agent-${id}`, `mcp-store-agent-${id}`, {
    nodes: [
      { id: nodeId, type: AGENT_NODE_TYPE, position: { x: 0, y: 0 }, data: { name } },
      {
        id: storeId,
        type: 'builtin.core.core-secrets-store',
        position: { x: 200, y: 0 },
        data: { secretKeys: Object.keys(stored) },
      },
    ],
    edges: [],
  })
  for (const [key, value] of Object.entries(stored)) {
    await secrets.set(storeId, key, value)
  }
  return { nodeId, identity: slug(name), storeId }
}

function server(name: string, patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, transport: 'http', url: `https://example.test/${name}`, ...patch }
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
  // The global list, unchanged, is the whole answer whatever mcpIdentity and
  // whatever MCP Connection nodes there are.
  await writeMcpServers([{ name: 'shared-team-server', transport: 'http', url: 'https://example.test/shared' }])
  await spaceWithConnectionNode('openproject-mcp-test-owner')
  const servers = await readMcpServersForAgent(selectionWithIdentity('test-owner'))
  assert.deepEqual(
    servers.map((s) => s.name),
    ['shared-team-server'],
  )
})

test('readMcpServersForAgent gives the agent the values its header and env secrets name, and typed values as they are', async () => {
  const agent = await agentWithSecrets({ MCP_STORE_TOKEN: 'Bearer placeholder-mcp-token', MCP_STORE_ENV: 'env-value' })
  await writeMcpServers([
    server('with-header', {
      headers: [
        { name: 'Authorization', value: 'secret:MCP_STORE_TOKEN' },
        { name: 'Accept', value: 'application/json' },
      ],
    }),
    server('with-env', {
      transport: 'stdio',
      url: undefined,
      command: 'mcp-server',
      env: [
        { name: 'API_KEY', value: 'secret:MCP_STORE_ENV' },
        { name: 'LOG_LEVEL', value: 'info' },
      ],
    }),
  ])

  const servers = await readMcpServersForAgent(selectionWithIdentity(agent.identity))

  assert.deepEqual(
    servers.map((s) => s.name),
    ['with-header', 'with-env'],
  )
  assert.deepEqual(servers[0]?.headers, [
    { name: 'Authorization', value: 'Bearer placeholder-mcp-token' },
    { name: 'Accept', value: 'application/json' },
  ])
  assert.deepEqual(servers[1]?.env, [
    { name: 'API_KEY', value: 'env-value' },
    { name: 'LOG_LEVEL', value: 'info' },
  ])
})

test('readMcpServersForAgent resolves on every load, so a rotated secret reaches the next session without a save', async () => {
  const agent = await agentWithSecrets({ MCP_STORE_ROTATED: 'first-value' })
  await writeMcpServers([server('rotating', { headers: [{ name: 'X-Key', value: 'secret:MCP_STORE_ROTATED' }] })])
  const before = await readMcpServersForAgent(selectionWithIdentity(agent.identity))
  assert.equal(before[0]?.headers?.[0]?.value, 'first-value')

  await secrets.set(agent.storeId, 'MCP_STORE_ROTATED', 'second-value')

  const after = await readMcpServersForAgent(selectionWithIdentity(agent.identity))
  assert.equal(after[0]?.headers?.[0]?.value, 'second-value')
})

test("readMcpServersForAgent looks a name up on the agent's own graph, so two agents get their own graph's value", async () => {
  const first = await agentWithSecrets({ MCP_STORE_SHARED_NAME: 'first-graph-value' })
  const second = await agentWithSecrets({ MCP_STORE_SHARED_NAME: 'second-graph-value' })
  await writeMcpServers([server('per-graph', { headers: [{ name: 'X-Key', value: 'secret:MCP_STORE_SHARED_NAME' }] })])

  const forFirst = await readMcpServersForAgent(selectionWithIdentity(first.identity))
  const forSecond = await readMcpServersForAgent(selectionWithIdentity(second.identity))

  assert.equal(forFirst[0]?.headers?.[0]?.value, 'first-graph-value')
  assert.equal(forSecond[0]?.headers?.[0]?.value, 'second-graph-value')
})

test('readMcpServersForAgent leaves out a server whose secret does not resolve, and keeps the others', async () => {
  const agent = await agentWithSecrets({ MCP_STORE_PRESENT: 'present-value' })
  await writeMcpServers([
    server('missing-secret', { headers: [{ name: 'Authorization', value: 'secret:MCP_STORE_NO_SUCH_NAME' }] }),
    server('present-secret', { headers: [{ name: 'Authorization', value: 'secret:MCP_STORE_PRESENT' }] }),
    server('typed-only', { headers: [{ name: 'Accept', value: 'application/json' }] }),
  ])

  const servers = await readMcpServersForAgent(selectionWithIdentity(agent.identity))

  assert.deepEqual(
    servers.map((s) => s.name),
    ['present-secret', 'typed-only'],
  )
})

test('readMcpServersForAgent leaves out a server that names a secret when the session is no single agent', async () => {
  // Control for the refusal: the same server is mounted for an identified agent.
  const agent = await agentWithSecrets({ MCP_STORE_UNATTRIBUTED: 'value' })
  await writeMcpServers([
    server('names-a-secret', { headers: [{ name: 'Authorization', value: 'secret:MCP_STORE_UNATTRIBUTED' }] }),
    server('typed-only', { headers: [{ name: 'Accept', value: 'application/json' }] }),
  ])

  const unattributed = await readMcpServersForAgent(selectionWithIdentity('no-agent-has-this-slug'))
  assert.deepEqual(
    unattributed.map((s) => s.name),
    ['typed-only'],
  )
  const attributed = await readMcpServersForAgent(selectionWithIdentity(agent.identity))
  assert.deepEqual(
    attributed.map((s) => s.name),
    ['names-a-secret', 'typed-only'],
  )
})

test('resolveMcpServerSecrets names the server and the secret when a name does not resolve', async () => {
  const agent = await agentWithSecrets({})
  await assert.rejects(
    resolveMcpServerSecrets(
      server('named', { env: [{ name: 'KEY', value: 'secret:MCP_STORE_ABSENT' }] }),
      agent.nodeId,
    ),
    (err: Error) => err.message.includes('"named"') && err.message.includes('MCP_STORE_ABSENT'),
  )
})

test('resolveMcpServerSecrets returns a server that names no secret unchanged, with or without an agent', async () => {
  const typed = server('typed', { headers: [{ name: 'Authorization', value: 'Bearer typed-placeholder' }] })
  assert.deepEqual(await resolveMcpServerSecrets(typed, null), typed)
})

test('isConnectionNodeName is true for a name an MCP Connection node already claims, false otherwise', async () => {
  await spaceWithConnectionNode('openproject-mcp-test-owner-4')
  assert.equal(await isConnectionNodeName('openproject-mcp-test-owner-4'), true)
  assert.equal(await isConnectionNodeName('openproject-mcp-nobody-claims-this'), false)
})
