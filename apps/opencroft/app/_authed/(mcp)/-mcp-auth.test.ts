// Who gets through the MCP endpoint, asserted by calling its real POST handler
// with real requests against a throwaway database — and who gets through a
// session-gated /api route with the same credential. The resolver is tested on
// its own in caller.test.ts; what has to be proved HERE is the route's
// decision: that each kind of caller ends in a 401 before any method runs, and
// that the one that does not is served as the agent its token names.
//
// Better Auth needs a secret before it will verify a session at all; in
// development mode it supplies its own, which is enough to answer "no session".
// Set in the module body, after the hoisted imports have run, which is early
// enough only because the auth instance reads it at first use, not at import.
process.env.NODE_ENV = 'development'

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, mcpToken, user } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { createTokenForUser } from '@/app/_authed/(settings)/_server/token-actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { Route as YoloRoute } from '@/app/api/yolo'
import { approvalStore } from '@/lib/approval-store'
import type { PendingApproval } from '@/lib/sse-events'
import { createMcpToken, deleteMcpToken } from './_server/mcp-tokens'
import { Route as McpRoute } from './mcp'

type Handler = (ctx: { request: Request }) => Promise<Response>

function handler(route: { options: { server?: { handlers?: unknown } } }, method: string): Handler {
  const handlers = route.options.server?.handlers as Record<string, Handler> | undefined
  const found = handlers?.[method]
  assert.ok(found, `the route must have a ${method} handler`)
  return found
}

const post = handler(McpRoute, 'POST')

async function call(method: string, authorization?: string, params?: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization) {
    headers.authorization = authorization
  }
  const request = new Request('http://localhost:9999/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return post({ request })
}

async function agentNode(name: string): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `mcp-auth-test-${crypto.randomUUID()}`
  const space = await registry.create(slug, slug, { nodes: [], edges: [] })
  const id = `mcp-auth-agent-${crypto.randomUUID()}`
  await registry.saveGraph(space.slug, {
    nodes: [{ id, type: 'agent', position: { x: 0, y: 0 }, data: { name } }],
    edges: [],
  })
  return id
}

async function personalToken(): Promise<string> {
  const userId = crypto.randomUUID()
  await db.insert(user).values({ id: userId, name: 'MCP Auth Person', email: `${userId}@example.test` })
  return (await createTokenForUser(userId, { name: 'laptop' })).token
}

async function assertRefused(response: Response, why: string): Promise<void> {
  assert.equal(response.status, 401, why)
  const body = (await response.json()) as { error?: { code: number }; result?: unknown }
  assert.equal(body.error?.code, -32001, `${why} — refused as a JSON-RPC error, not served`)
  assert.equal(body.result, undefined, `${why} — nothing may be served alongside the refusal`)
}

test('a request with no credential is refused', async () => {
  await assertRefused(await call('tools/list'), 'no Authorization header')
})

test('an unknown token is refused', async () => {
  await assertRefused(await call('tools/list', 'Bearer ocm_never_issued'), 'a token nobody issued')
})

test('a personal access token is refused, however valid', async () => {
  await assertRefused(await call('tools/list', `Bearer ${await personalToken()}`), 'a live personal token')
})

test('an expired MCP token is refused', async () => {
  const nodeId = await agentNode('MCP Auth Expired')
  const created = await createMcpToken(nodeId, {
    name: 'expiring',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal((await call('tools/list', `Bearer ${created.token}`)).status, 200, 'served while live')

  await db
    .update(mcpToken)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(mcpToken.id, created.id))

  await assertRefused(await call('tools/list', `Bearer ${created.token}`), 'an expired token')
})

test('a deleted MCP token is refused', async () => {
  const nodeId = await agentNode('MCP Auth Deleted')
  const created = await createMcpToken(nodeId, { name: 'deleting', expiresAt: null })
  assert.equal((await call('tools/list', `Bearer ${created.token}`)).status, 200, 'served before deletion')

  await deleteMcpToken(nodeId, created.id)

  await assertRefused(await call('tools/list', `Bearer ${created.token}`), 'a deleted token')
})

test('the refusal covers every method, initialize included', async () => {
  await assertRefused(await call('initialize'), 'initialize without a token')
  await assertRefused(await call('tools/call', undefined, { name: 'list_spaces', arguments: {} }), 'a tool call')
})

// The identity has to reach the tool as the node the token names. The tool is
// one that refuses a caller it cannot identify, so a served result is that
// gate passing on the token's agent — not on some default.
test('a valid MCP token is served, as the agent it was issued to', async () => {
  const nodeId = await agentNode('MCP Auth Served')
  const { token } = await createMcpToken(nodeId, { name: 'client', expiresAt: null })

  const listed = await call('tools/list', `Bearer ${token}`)
  assert.equal(listed.status, 200)
  const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools
  assert.ok(
    tools.some((t) => t.name === 'group_chat_list'),
    'the agent-acting tools must be listed to a token holder',
  )

  const called = await call('tools/call', `Bearer ${token}`, { name: 'group_chat_list', arguments: {} })
  assert.equal(called.status, 200)
  const result = ((await called.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result
  assert.notEqual(result.isError, true, `the agent-acting tool refused the token's agent: ${result.content[0]?.text}`)
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? 'null'), [], 'a fresh agent is in no group chats')
})

// A graph's reads and writes are `app_call`s on its address, so they sit behind
// the same refusal as every other tool. One read and one write, refused without
// a token; the control — the same two with a token — is served, the write once
// its approval is granted, which is also what shows the refusal was the token's
// doing and not the call's.
test('a graph read and a graph write through app_call are refused without a token, served with one', async () => {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `mcp-auth-graph-${crypto.randomUUID()}`
  await registry.create(slug, slug, { nodes: [], edges: [] })
  const [graph] = registry.graphsOf(slug)
  assert.ok(graph, 'the space has its default graph')
  const address = `${slug}.${graph.slug}`
  const read = { name: 'app_call', arguments: { app: address, action: 'listNodes' } }
  const write = {
    name: 'app_call',
    arguments: { app: address, action: 'createNodes', params: { nodes: [{ type: 'note' }] } },
  }

  await assertRefused(await call('tools/call', undefined, read), 'a graph read without a token')
  await assertRefused(await call('tools/call', undefined, write), 'a graph write without a token')
  assert.deepEqual((await registry.resolveGraph(address))?.graph.graph.nodes, [], 'the refused write wrote nothing')

  const nodeId = await agentNode('MCP Auth Graph')
  const { token } = await createMcpToken(nodeId, { name: 'client', expiresAt: null })

  const served = await call('tools/call', `Bearer ${token}`, read)
  assert.equal(served.status, 200)
  const readResult = ((await served.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result
  assert.notEqual(readResult.isError, true, readResult.content[0]?.text)
  assert.deepEqual(JSON.parse(readResult.content[0]?.text ?? 'null'), [], 'the empty graph, listed')

  const pendingWrite = call('tools/call', `Bearer ${token}`, write)
  let request: PendingApproval | undefined
  for (let i = 0; i < 400 && !request; i++) {
    request = approvalStore.list().find((r) => r.tool === 'app_call' && r.spaceId === slug)
    if (!request) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  assert.ok(request, 'the write queued for approval in its graph’s space')
  approvalStore.approve(request.id)
  const written = await pendingWrite
  assert.equal(written.status, 200)
  assert.equal((await registry.resolveGraph(address))?.graph.graph.nodes.length, 1, 'the served write landed')
})

// Names are free text two nodes can share. A lookup by name gives one answer
// for both twins; the node carried from the token gives each its own, which is
// the only outcome that shows the name was not used to find the agent again.
test('two same-named agents resolve to their own nodes when identified by token', async () => {
  const { requireAgentNode } = await import('@/app/_authed/(group-chats)/_server/model')
  const { requireCallingAgent } = await import('./_server/tool-shared')
  const first = await agentNode('MCP Auth Twin')
  const second = await agentNode('MCP Auth Twin')

  const asFirst = requireCallingAgent({ agent: 'MCP Auth Twin', agentNodeId: first })
  const asSecond = requireCallingAgent({ agent: 'MCP Auth Twin', agentNodeId: second })

  assert.deepEqual(asSecond, { nodeId: second, name: 'MCP Auth Twin' })
  assert.equal(await requireAgentNode(asFirst), first)
  assert.equal(await requireAgentNode(asSecond), second)
  // The bridge's form — a name alone — still resolves, to one of them.
  assert.ok([first, second].includes(await requireAgentNode(requireCallingAgent({ agent: 'MCP Auth Twin' }))))
})

// An MCP token authenticates the MCP endpoint and nothing else. No /api route
// reads a bearer credential — they answer to a session — and this pins that a
// token which the MCP endpoint would serve gets nothing from one of them.
test('an MCP token is refused on another /api route', async () => {
  const nodeId = await agentNode('MCP Auth Elsewhere')
  const { token } = await createMcpToken(nodeId, { name: 'client', expiresAt: null })
  const served = await call('tools/list', `Bearer ${token}`)
  assert.equal(served.status, 200, 'the token must be live, or this proves nothing')

  const getYolo = handler(YoloRoute, 'GET')
  const response = await getYolo({
    request: new Request('http://localhost:9999/api/yolo', { headers: { authorization: `Bearer ${token}` } }),
  })

  assert.equal(response.status, 401)
})
