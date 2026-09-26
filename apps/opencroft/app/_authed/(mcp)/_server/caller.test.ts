// Exercises credential resolution and caller recording against a real
// (throwaway) database rather than a mock. What is worth proving is that the
// table definitions, the migrations and the upsert actually agree — a mock
// would hide exactly the disagreement that matters. See @opencroft/db's
// test-env for how this stays off the shared dev/production database.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, mcpCaller, mcpToken, user } from '@opencroft/db'
import { and, eq } from 'drizzle-orm'

import { createTokenForUser } from '@/app/_authed/(settings)/_server/token-actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { recordCaller, resolveCaller } from './caller'
import { createMcpToken, deleteMcpToken } from './mcp-tokens'

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:9999/mcp', { method: 'POST', headers })
}

function bearer(token: string): Request {
  return req({ authorization: `Bearer ${token}` })
}

/** A space holding one agent node per name; returns their node ids in order. */
async function agentNodes(names: string[]): Promise<string[]> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `caller-test-${crypto.randomUUID()}`
  const space = await registry.create(slug, slug, { nodes: [], edges: [] })
  const ids = names.map((_, i) => `caller-agent-${i}-${crypto.randomUUID()}`)
  await registry.saveGraph(space.slug, {
    nodes: names.map((name, i) => ({ id: ids[i], type: 'agent', position: { x: 0, y: 0 }, data: { name } })),
    edges: [],
  })
  return ids
}

async function mint(agentNodeId: string, expiresAt: string | null = null): Promise<string> {
  return (await createMcpToken(agentNodeId, { name: 'test', expiresAt })).token
}

/** Run `fn` and return every `[mcp-caller]` line it emitted. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.filter((l) => l.startsWith('[mcp-caller]'))
}

test('no Authorization header resolves as absent, not unknown', async () => {
  const caller = await resolveCaller(req())
  assert.deepEqual(caller, { credential: 'absent', agent: null, agentNodeId: null, tokenId: null })
})

test('an MCP token resolves to the agent node it was issued to, and that node’s name', async () => {
  const [nodeId] = await agentNodes(['Caller Alice'])
  const token = await mint(nodeId)

  const caller = await resolveCaller(bearer(token))

  assert.equal(caller.credential, 'present')
  assert.equal(caller.agentNodeId, nodeId)
  assert.equal(caller.agent, 'Caller Alice')
  assert.ok(caller.tokenId)
})

test('an MCP token carries the ocm_ prefix, so it cannot be mistaken for a personal token', async () => {
  const [nodeId] = await agentNodes(['Caller Prefix'])
  assert.match(await mint(nodeId), /^ocm_/)
})

// Two nodes may share a name. The identity has to be the node the token was
// issued to — resolving through the name could land on the other one.
test('a token issued to one of two same-named agents resolves to that one', async () => {
  const [first, second] = await agentNodes(['Caller Twin', 'Caller Twin'])
  const caller = await resolveCaller(bearer(await mint(second)))

  assert.equal(caller.agentNodeId, second)
  assert.notEqual(caller.agentNodeId, first)
})

test('the Bearer scheme is matched case-insensitively, as RFC 7235 requires', async () => {
  const [nodeId] = await agentNodes(['Caller Case'])
  const token = await mint(nodeId)
  const caller = await resolveCaller(req({ authorization: `bearer ${token}` }))
  assert.equal(caller.credential, 'present')
})

test('an MCP token is read from X-API-Key', async () => {
  const [nodeId] = await agentNodes(['Caller Api Key'])
  const caller = await resolveCaller(req({ 'x-api-key': await mint(nodeId) }))
  assert.equal(caller.credential, 'present')
  assert.equal(caller.agentNodeId, nodeId)
})

// A reverse proxy's basic auth occupies Authorization; the token has to get
// through beside it.
test('X-API-Key is read when Authorization carries a proxy’s Basic credential', async () => {
  const [nodeId] = await agentNodes(['Caller Behind Proxy'])
  const token = await mint(nodeId)
  const caller = await resolveCaller(req({ authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': token }))
  assert.equal(caller.credential, 'present')
  assert.equal(caller.agentNodeId, nodeId)
})

test('X-API-Key wins over a Bearer token when both are sent', async () => {
  const [first, second] = await agentNodes(['Caller Key Wins', 'Caller Bearer Loses'])
  const caller = await resolveCaller(
    req({ 'x-api-key': await mint(first), authorization: `Bearer ${await mint(second)}` }),
  )
  assert.equal(caller.agentNodeId, first)
})

test('a Basic Authorization header alone is no credential at all', async () => {
  const caller = await resolveCaller(req({ authorization: 'Basic dXNlcjpwYXNz' }))
  assert.equal(caller.credential, 'absent')
})

// The distinction this asserts is the whole point of having three states:
// `unknown` is a client that WAS configured and is now wrong, `absent` is a
// client nobody has touched.
test('an unrecognised token resolves as unknown, distinct from absent', async () => {
  const caller = await resolveCaller(bearer('ocm_never_minted'))
  assert.deepEqual(caller, { credential: 'unknown', agent: null, agentNodeId: null, tokenId: null })
})

test('a deleted token stops resolving on the next request', async () => {
  const [nodeId] = await agentNodes(['Caller Deleted'])
  const created = await createMcpToken(nodeId, { name: 'to-delete', expiresAt: null })

  const before = await resolveCaller(bearer(created.token))
  assert.equal(before.credential, 'present', 'must work before deletion, or the test proves nothing')

  await deleteMcpToken(nodeId, created.id)

  assert.equal((await resolveCaller(bearer(created.token))).credential, 'unknown')
})

test('an expired token stops resolving on its own', async () => {
  const [nodeId] = await agentNodes(['Caller Expiring'])
  const created = await createMcpToken(nodeId, {
    name: 'to-expire',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal((await resolveCaller(bearer(created.token))).credential, 'present', 'live before it is aged out')

  // createMcpToken refuses a past expiry, so an expired token is only
  // reachable by aging one out.
  await db
    .update(mcpToken)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(mcpToken.id, created.id))

  assert.equal((await resolveCaller(bearer(created.token))).credential, 'unknown')
})

test('a token whose agent node no longer exists resolves to nobody', async () => {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `caller-test-gone-${crypto.randomUUID()}`
  const space = await registry.create(slug, slug, { nodes: [], edges: [] })
  const nodeId = `caller-agent-gone-${crypto.randomUUID()}`
  await registry.saveGraph(space.slug, {
    nodes: [{ id: nodeId, type: 'agent', position: { x: 0, y: 0 }, data: { name: 'Caller Gone' } }],
    edges: [],
  })
  const token = await mint(nodeId)
  assert.equal((await resolveCaller(bearer(token))).credential, 'present', 'live while the node exists')

  await registry.saveGraph(space.slug, { nodes: [], edges: [] })

  const caller = await resolveCaller(bearer(token))
  assert.equal(caller.credential, 'unknown')
  assert.equal(caller.agentNodeId, null)
})

test('a personal access token does not resolve here, however valid it is', async () => {
  const userId = crypto.randomUUID()
  await db.insert(user).values({ id: userId, name: 'Caller Person', email: `${userId}@example.test` })
  const personal = await createTokenForUser(userId, { name: 'laptop' })

  assert.equal((await resolveCaller(bearer(personal.token))).credential, 'unknown')
})

// Rotation with a single credential means a window where the old token is dead
// and the new one is not yet configured. Several live tokens per agent is what
// removes that window, so it is worth a test rather than an assumption.
test('an agent can hold several live tokens at once', async () => {
  const [nodeId] = await agentNodes(['Caller Carol'])
  const first = await resolveCaller(bearer(await mint(nodeId)))
  const second = await resolveCaller(bearer(await mint(nodeId)))

  assert.equal(first.agentNodeId, nodeId)
  assert.equal(second.agentNodeId, nodeId)
  assert.notEqual(first.tokenId, second.tokenId)
})

test('issuing a token to a node that is not an agent is refused', async () => {
  await assert.rejects(() => createMcpToken(`not-an-agent-${crypto.randomUUID()}`, { name: 'x', expiresAt: null }), {
    message: /only be issued to an agent node/,
  })
})

test('an expiry must be a date ahead, or explicitly null for never', async () => {
  const [nodeId] = await agentNodes(['Caller Expiry Rules'])
  await assert.rejects(() => createMcpToken(nodeId, { name: 'x', expiresAt: '2020-01-01' }), { message: /future/ })
  await assert.rejects(() => createMcpToken(nodeId, { name: 'x', expiresAt: 'soon' }), { message: /Invalid expiry/ })
  // An absent expiry is not "never": only an explicit null says that.
  await assert.rejects(
    () => createMcpToken(nodeId, { name: 'x' } as unknown as { name: string; expiresAt: string | null }),
    { message: /Invalid expiry/ },
  )
})

test('deleting through another node’s id fails as if the token did not exist, and deletes nothing', async () => {
  const [owner, other] = await agentNodes(['Caller Owner', 'Caller Other'])
  const created = await createMcpToken(owner, { name: 'owned', expiresAt: null })

  await assert.rejects(() => deleteMcpToken(other, created.id), { message: /not found/ })
  assert.equal((await resolveCaller(bearer(created.token))).credential, 'present')
})

test('repeat calls from one caller aggregate onto a single row', async () => {
  const request = req({ 'user-agent': 'probe/1.0', 'x-forwarded-for': '10.0.0.7' })
  const caller = { credential: 'absent' as const, agent: null, agentNodeId: null, tokenId: null }

  for (let i = 0; i < 3; i++) {
    await recordCaller({ caller, method: 'tools/list', tool: null, request })
  }

  const rows = await db
    .select()
    .from(mcpCaller)
    .where(and(eq(mcpCaller.method, 'tools/list'), eq(mcpCaller.userAgent, 'probe/1.0')))

  assert.equal(rows.length, 1, 'three requests from one caller must be one row, not three')
  assert.equal(rows[0].seenCount, 3)
  assert.equal(rows[0].sourceIp, '10.0.0.7')
  assert.ok(rows[0].lastSeenAt >= rows[0].firstSeenAt)
})

test('callers differing only by user agent are recorded separately', async () => {
  const caller = { credential: 'absent' as const, agent: null, agentNodeId: null, tokenId: null }

  await recordCaller({ caller, method: 'initialize', tool: null, request: req({ 'user-agent': 'alpha/1' }) })
  await recordCaller({ caller, method: 'initialize', tool: null, request: req({ 'user-agent': 'beta/1' }) })

  const rows = await db.select().from(mcpCaller).where(eq(mcpCaller.method, 'initialize'))
  assert.equal(rows.length, 2)
})

test('tool name is part of the caller identity, so per-tool usage is visible', async () => {
  const caller = { credential: 'absent' as const, agent: null, agentNodeId: null, tokenId: null }
  const request = req({ 'user-agent': 'tooler/1' })

  await recordCaller({ caller, method: 'tools/call', tool: 'remote_exec', request })
  await recordCaller({ caller, method: 'tools/call', tool: 'app_call', request })

  const rows = await db.select().from(mcpCaller).where(eq(mcpCaller.method, 'tools/call'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.tool).sort(), ['app_call', 'remote_exec'])
})

test('a resolved caller is recorded by its node, and its token’s lastUsedAt is stamped', async () => {
  const [nodeId] = await agentNodes(['Caller Stamper'])
  const caller = await resolveCaller(bearer(await mint(nodeId)))
  await recordCaller({ caller, method: 'tools/list', tool: null, request: req({ 'user-agent': 'stamper/1' }) })

  const [token] = await db
    .select()
    .from(mcpToken)
    .where(eq(mcpToken.id, caller.tokenId as string))
  assert.ok(token.lastUsedAt, 'lastUsedAt must be set, or a stale token is indistinguishable from a live one')

  const [row] = await db.select().from(mcpCaller).where(eq(mcpCaller.userAgent, 'stamper/1'))
  assert.equal(row.agentNodeId, nodeId)
  assert.equal(row.agent, 'Caller Stamper')
})

// The log carries the per-request trace that the table deliberately collapses,
// so its shape is a contract rather than a debugging aid.
test('every observed request emits exactly one [mcp-caller] line', async () => {
  const caller = { credential: 'absent' as const, agent: null, agentNodeId: null, tokenId: null }
  const request = req({ 'user-agent': 'liner/1.0', 'x-forwarded-for': '10.0.0.9' })

  const lines = await captureLog(async () => {
    for (let i = 0; i < 3; i++) {
      await recordCaller({ caller, method: 'tools/list', tool: null, request })
    }
  })

  assert.equal(lines.length, 3, 'the log keeps every call — collapsing them is the table’s job')
  assert.equal(lines[0], '[mcp-caller] credential=absent agent=- method=tools/list tool=- ip=10.0.0.9 ua="liner/1.0"')
})

// A user agent with a space or a quote must not be able to forge extra fields
// in a line someone greps and eyeballs.
test('the user agent is quoted, so it cannot forge fields in the line', async () => {
  const [line] = await captureLog(async () => {
    await recordCaller({
      caller: { credential: 'absent', agent: null, agentNodeId: null, tokenId: null },
      method: 'initialize',
      tool: null,
      request: req({ 'user-agent': 'evil/1 credential=present agent=admin' }),
    })
  })

  assert.match(line, /ua="evil\/1 credential=present agent=admin"/)
  assert.equal(line.match(/credential=/g)?.length, 2, 'one real field, one inside the quoted user agent')
  assert.match(line, /^\[mcp-caller\] credential=absent /, 'the real credential stays the first field')
})
