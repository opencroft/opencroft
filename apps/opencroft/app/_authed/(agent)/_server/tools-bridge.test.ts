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

import type { BackgroundTaskOwner, BackgroundTaskService } from '@/app/_authed/(background-tasks)/_server/types'
import { ASYNC_SENTENCE, AWAITABLE_SENTENCE } from '@/app/_authed/(mcp)/_server/execution-mode'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { opencroftLocalTools } from './tools-bridge'

// After the bridge, which loads the tools barrel first; see task-tools.test.ts
// for why a tool family module is never the first way into that cycle.
const { substituteBackgroundTaskService } = await import('@/app/_authed/(mcp)/_server/task-tools')

// The tool stands in for the whole agent-acting family: it is gated by
// `requireCallingAgent`, so its refusal is that gate speaking.
const AGENT_ACTING_TOOL = 'group_chat_list'

async function spaceWithAgents(names: string[]): Promise<void> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `tools-bridge-test-${crypto.randomUUID()}`
  await registry.create(slug, slug, {
    nodes: names.map((name, i) => ({
      id: `bridge-agent-${i}-${crypto.randomUUID()}`,
      type: 'builtin.core.agent',
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

// The bridge is the app's own agents reaching their tools in-process. It never
// presented a credential and must not start needing one now that the HTTP
// endpoint takes MCP tokens only: the table is empty here, and the call is
// still attributed from the session alone.
test('a bridged call needs no MCP token', async () => {
  const { db, mcpToken } = await import('@opencroft/db')
  await spaceWithAgents(['Bridge Tokenless Agent'])
  assert.equal((await db.select().from(mcpToken)).length, 0, 'precondition: no MCP token exists at all')

  const result = await callAgentActingTool({ mcpIdentity: 'bridge-tokenless-agent' })

  assert.notEqual(result.isError, true, `the bridge refused without a token: ${JSON.stringify(result)}`)
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

// The session, like the agent, comes from the session's own bookkeeping and
// reaches the tool handler with the call: it is where a background task's result
// is delivered. task_status stands in for the tools that key on it — listing
// "your own tasks" asks the service for exactly the caller it was handed.
async function ownerSeenByTaskStatus(
  caller: Parameters<typeof opencroftLocalTools>[0],
  args: Record<string, unknown> = {},
) {
  const owners: BackgroundTaskOwner[] = []
  const unexpected = async (): Promise<never> => {
    throw new Error('not expected in this test')
  }
  const service: BackgroundTaskService = {
    startRunnerTask: unexpected,
    startInProcessTask: unexpected,
    get: unexpected,
    listForOwner: async (owner) => {
      owners.push(owner)
      return []
    },
    listRunning: unexpected,
    cancel: unexpected,
    runningSessionKeys: () => new Set(),
    subscribeRunningSessionKeys: () => () => {},
  }
  substituteBackgroundTaskService(service)
  try {
    const tool = (await opencroftLocalTools(caller)).find((t) => t.name === 'task_status')
    assert.ok(tool, 'task_status must be in the bridged toolset')
    const result = (await tool.handler(args)) as Record<string, unknown>
    assert.notEqual(result.isError, true, `task_status refused: ${JSON.stringify(result)}`)
  } finally {
    substituteBackgroundTaskService(undefined)
  }
  return owners
}

test('a bridged call carries the id of the session it came from', async () => {
  const owners = await ownerSeenByTaskStatus({ sessionId: 'bridge-session-7' })
  assert.deepEqual(owners, [{ agent: null, sessionId: 'bridge-session-7' }])
})

test('a bridged call from no session carries none, rather than a made-up one', async () => {
  await spaceWithAgents(['Bridge Sessionless Agent'])
  const owners = await ownerSeenByTaskStatus({ mcpIdentity: 'bridge-sessionless-agent' })
  assert.deepEqual(owners, [{ agent: 'Bridge Sessionless Agent' }], 'no session key at all, not an undefined one')
})

test('the session cannot be supplied as a tool argument', async () => {
  // Same rule as the agent: an argument naming a session must not become one,
  // or any caller could have its task's result delivered into any conversation.
  await spaceWithAgents(['Bridge Session Argument Agent'])
  const owners = await ownerSeenByTaskStatus(
    { mcpIdentity: 'bridge-session-argument-agent' },
    { sessionId: 'someone-elses-session', callerSessionId: 'someone-elses-session' },
  )
  assert.deepEqual(owners, [{ agent: 'Bridge Session Argument Agent' }])
})

// A graph-defined tool marked on its node is offered the way a static one is:
// the bridge lists what the registry presents, not the node's raw declaration.
test('a bridged agent-tool node marked awaitable offers background; one marked async says it answers later', async () => {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const suffix = crypto.randomUUID().slice(0, 8)
  const slug = `tools-bridge-marked-${suffix}`
  const schema = JSON.stringify({ type: 'object', properties: { q: { type: 'string' } } })
  const tool = (name: string, execution: string) => ({
    id: `bridge-tool-${name}`,
    type: 'builtin.core.agent-tool',
    position: { x: 0, y: 0 },
    data: { name, description: 'Look it up.', inputSchema: schema, requireApproval: false, execution },
  })
  const awaitable = `bridge_awaitable_${suffix}`
  const asyncTool = `bridge_async_${suffix}`
  await registry.create(slug, slug, { nodes: [tool(awaitable, 'awaitable'), tool(asyncTool, 'async')], edges: [] })

  const tools = await opencroftLocalTools({})
  const listedAwaitable = tools.find((t) => t.name === awaitable)
  const listedAsync = tools.find((t) => t.name === asyncTool)
  assert.ok(listedAwaitable && listedAsync, 'both are bridged')
  assert.deepEqual(Object.keys(listedAwaitable.inputSchema), ['q', 'background', 'timeoutMinutes'])
  assert.equal(listedAwaitable.description, `Look it up. ${AWAITABLE_SENTENCE}`)
  assert.deepEqual(Object.keys(listedAsync.inputSchema), ['q'], 'an async tool asks nothing new')
  assert.equal(listedAsync.description, `Look it up. ${ASYNC_SENTENCE}`)
})

// agent-client registers its own `skill`, filtered by the agent's role; the
// registry's copy reaching it as well would be a second tool of the same name,
// which the MCP server refuses to register.
test('the bridged toolset leaves the skill tool to agent-client', async () => {
  const names = (await opencroftLocalTools({})).map((t) => t.name)

  assert.ok(!names.includes('skill'), 'the registry skill tool must not reach the bridge')
  assert.ok(names.includes('skill_list'), 'the rest of the skill family still does')
})
