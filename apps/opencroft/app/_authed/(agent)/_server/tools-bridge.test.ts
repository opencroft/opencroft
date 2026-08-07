// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env for how this stays off the shared dev/production database.
//
// The property under test is who a bridged tool call is attributed to. Tools
// that act AS the calling agent are only as trustworthy as that answer, and the
// bridge presents no credential, so the identity has to come from the session's
// own bookkeeping — or not at all.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { opencroftLocalTools } from './tools-bridge'

// The tool stands in for the whole agent-acting family: it is gated by
// `requireCallingAgent`, so its refusal is that gate speaking.
const AGENT_ACTING_TOOL = 'group_chat_list'

async function spaceWithAgents(names: string[]): Promise<void> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `tools-bridge-test-${crypto.randomUUID()}`
  const space = await registry.create(slug, slug, { nodes: [], edges: [] })
  await registry.saveGraph(space.slug, {
    nodes: names.map((name, i) => ({
      id: `bridge-agent-${i}-${crypto.randomUUID()}`,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { name },
    })),
    edges: [],
  })
}

async function callAgentActingTool(
  caller: Parameters<typeof opencroftLocalTools>[0],
): Promise<Record<string, unknown>> {
  const tools = await opencroftLocalTools(caller)
  const tool = tools.find((t) => t.name === AGENT_ACTING_TOOL)
  assert.ok(tool, `${AGENT_ACTING_TOOL} must be in the bridged toolset`)
  return (await tool.handler({})) as Record<string, unknown>
}

test('a bridged call carries the identity of the session it came from', async () => {
  await spaceWithAgents(['Bridge Identity Agent'])

  // The workspace slug is what a session's `mcpIdentity` holds (see acp-impl),
  // so this is the value the engine really hands over — not a name spelled the
  // way the tool wants it.
  const result = await callAgentActingTool({ mcpIdentity: 'bridge-identity-agent' })

  assert.notEqual(result.isError, true, `the tool refused instead of resolving the caller: ${JSON.stringify(result)}`)
})

test('a bridged call from a session with no identity is refused, not defaulted', async () => {
  await spaceWithAgents(['Bridge Unidentified Agent'])

  const result = await callAgentActingTool({})

  assert.equal(result.isError, true, 'an unidentified session must not reach a tool that acts as an agent')
  assert.match(JSON.stringify(result.content), /did not identify one/)
})

test('an identity matching no agent node is refused rather than passed through', async () => {
  await spaceWithAgents(['Bridge Real Agent'])

  // A session whose agent node has since been renamed or removed: the slug it
  // was opened with no longer names anything.
  const result = await callAgentActingTool({ mcpIdentity: 'bridge-agent-that-is-gone' })

  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /did not identify one/)
})

test('two agents whose names share a slug make the caller ambiguous, and ambiguous is refused', async () => {
  // Legal state: node names are not unique, and the workspace slug is all a
  // session carries. Picking either one would be delivering as the wrong agent.
  await spaceWithAgents(['Bridge Twin Agent', 'bridge twin agent'])

  const result = await callAgentActingTool({ mcpIdentity: 'bridge-twin-agent' })

  assert.equal(result.isError, true, 'a tie must refuse rather than pick a side')
  assert.match(JSON.stringify(result.content), /did not identify one/)
})

test('the caller cannot be supplied as a tool argument', async () => {
  await spaceWithAgents(['Bridge Argument Agent'])

  // Even spelled exactly as the resolved identity would be, an argument must
  // not become an identity: the session said nothing, so nobody is calling.
  const tools = await opencroftLocalTools({})
  const tool = tools.find((t) => t.name === AGENT_ACTING_TOOL)
  assert.ok(tool)
  const result = (await tool.handler({
    agent: 'Bridge Argument Agent',
    agentName: 'Bridge Argument Agent',
    callerAgent: 'Bridge Argument Agent',
  })) as Record<string, unknown>

  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /did not identify one/)
})
