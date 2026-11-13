// Exercises the real database (embedded PGlite) through handleToolCall, the way
// both MCP surfaces reach these tools. See @opencroft/db's test-env for how this
// stays off the shared dev/production database.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { writeMcpServers } from '@/app/_authed/(agent)/_server/mcp-store'
import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { handleToolCall } from './tools'

function textOf(result: Record<string, unknown>): string {
  const content = result.content as { text?: string }[] | undefined
  return content?.[0]?.text ?? ''
}

async function agentNode(): Promise<{ nodeId: string; name: string }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const id = crypto.randomUUID()
  const nodeId = `agent-${id}`
  const name = `MCP Tools Agent ${id}`
  await registry.create(`mcp-tools-${id}`, `mcp-tools-${id}`, {
    nodes: [{ id: nodeId, type: AGENT_NODE_TYPE, position: { x: 0, y: 0 }, data: { name } }],
    edges: [],
  })
  return { nodeId, name }
}

test('mcp_list shows a value that names a secret as its name, and masks typed values', async () => {
  await writeMcpServers([
    {
      name: 'listed',
      transport: 'http',
      url: 'https://user:typed-password@example.test/mcp',
      headers: [
        { name: 'Authorization', value: 'secret:MCP_TOOLS_TOKEN' },
        { name: 'X-Typed', value: 'typed-placeholder-value' },
      ],
    },
  ])

  const text = textOf(await handleToolCall('mcp_list', {}, {}))

  const [listed] = JSON.parse(text) as { url: string; headers: { name: string; value: string }[] }[]
  assert.deepEqual(listed?.headers, [
    { name: 'Authorization', value: 'secret:MCP_TOOLS_TOKEN' },
    { name: 'X-Typed', value: '***' },
  ])
  assert.ok(!text.includes('typed-placeholder-value'))
  assert.ok(!text.includes('typed-password'))
})

test('mcp_test reports a secret the calling agent cannot resolve, naming it, without connecting', async () => {
  const agent = await agentNode()
  await writeMcpServers([
    {
      name: 'tested',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'secret:MCP_TOOLS_NO_SUCH_NAME' }],
    },
  ])

  const byNode = JSON.parse(
    textOf(await handleToolCall('mcp_test', { name: 'tested' }, { callerAgentNodeId: agent.nodeId })),
  )
  assert.equal(byNode.ok, false)
  assert.match(byNode.error, /"tested".*MCP_TOOLS_NO_SUCH_NAME/)

  // The in-process bridge names the agent and no node; the one agent of that name is the caller.
  const byName = JSON.parse(textOf(await handleToolCall('mcp_test', { name: 'tested' }, { callerAgent: agent.name })))
  assert.match(byName.error, /MCP_TOOLS_NO_SUCH_NAME/)
})

test('mcp_test refuses a server that names a secret when no single agent is calling', async () => {
  await writeMcpServers([
    {
      name: 'unattributed',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'secret:MCP_TOOLS_TOKEN' }],
    },
  ])

  const result = JSON.parse(textOf(await handleToolCall('mcp_test', { name: 'unattributed' }, {})))

  assert.equal(result.ok, false)
  assert.match(result.error, /no single agent/)
})
