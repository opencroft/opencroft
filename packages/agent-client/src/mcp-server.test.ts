import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpServer, type LocalTool, loadSkills, type ToolsCaller } from './mcp-server'
import { type ResolvedPermissions, skillKey } from './permissions'

// The built-in MCP server builds a fresh server per request, so every request —
// initialize included — runs the tools factory. That makes the factory the
// place to observe who the request was attributed to, without needing a full
// tool-call round trip.

interface Harness {
  url: string
  seen: ToolsCaller[]
  close: () => Promise<void>
}

async function serverThatRecordsCallers(name: string, callerFor?: (token: string) => ToolsCaller): Promise<Harness> {
  const seen: ToolsCaller[] = []
  const tools = async (caller: ToolsCaller): Promise<LocalTool[]> => {
    seen.push(caller)
    return []
  }
  const handle = createMcpServer({ name, tools, skills: [], callerFor })
  return { url: await handle.ensureUrl(), seen, close: handle.close }
}

async function post(url: string, headers: Record<string, string>): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  })
}

test('the session token on a request decides who the tools factory builds for', async () => {
  const harness = await serverThatRecordsCallers(`caller-identity-${crypto.randomUUID()}`, (token) =>
    token === 'known-token' ? { mcpIdentity: 'agent-one' } : {},
  )
  try {
    await post(harness.url, { 'x-agent-session': 'known-token' })
    assert.deepEqual(harness.seen.at(-1), { mcpIdentity: 'agent-one' })
  } finally {
    await harness.close()
  }
})

test('a request with no session token yields no identity at all', async () => {
  const harness = await serverThatRecordsCallers(`caller-absent-${crypto.randomUUID()}`, () => ({
    mcpIdentity: 'must-not-be-used',
  }))
  try {
    await post(harness.url, {})
    // Not merely "not agent-one": nothing. A resolver that is never consulted
    // cannot hand back a default, which is the whole point of asserting this.
    assert.deepEqual(harness.seen.at(-1), {})
  } finally {
    await harness.close()
  }
})

test('a token that resolves to no session yields no identity', async () => {
  const harness = await serverThatRecordsCallers(`caller-unknown-${crypto.randomUUID()}`, (token) =>
    token === 'known-token' ? { mcpIdentity: 'agent-one' } : {},
  )
  try {
    await post(harness.url, { 'x-agent-session': 'a-token-from-a-session-that-ended' })
    assert.deepEqual(harness.seen.at(-1), {})
  } finally {
    await harness.close()
  }
})

test('a host that resolves no callers at all still gets a caller object, never undefined', async () => {
  // `callerFor` is optional, and a factory should not have to defend against
  // being handed nothing.
  const harness = await serverThatRecordsCallers(`caller-none-${crypto.randomUUID()}`)
  try {
    await post(harness.url, { 'x-agent-session': 'ignored' })
    assert.deepEqual(harness.seen.at(-1), {})
  } finally {
    await harness.close()
  }
})

// The skill tool loads a batch of names, so the joining, de-duplication and
// per-name permission guard all live in loadSkills — shared by this server and
// the native harness.

const skillBody = async (name: string) => `body of ${name}`

test('a lone skill comes back as its body, with no heading added', async () => {
  assert.equal(await loadSkills(['alpha'], skillBody, undefined), 'body of alpha')
})

test('a batch is labeled per skill, de-duplicated, trimmed and stripped of blanks', async () => {
  const loaded = await loadSkills(['alpha', ' beta ', 'alpha', '   '], skillBody, undefined)
  assert.equal(loaded, '<skill name="alpha">\nbody of alpha\n</skill>\n\n<skill name="beta">\nbody of beta\n</skill>')
})

test('a request naming no usable skill reports that instead of reaching the handler', async () => {
  let calls = 0
  const loaded = await loadSkills(
    ['', '  '],
    async (name) => {
      calls += 1
      return name
    },
    undefined,
  )
  assert.match(loaded, /provide at least one skill name/)
  assert.equal(calls, 0)
})

test('a skill the session cannot reach is withheld while the permitted ones still load', async () => {
  const permissions: ResolvedPermissions = {
    mode: 'scoped',
    allow: { [skillKey('alpha')]: 'Allow' },
    defaultAccess: 'Allow',
  }
  const loaded = await loadSkills(['alpha', 'secret'], skillBody, permissions)
  assert.equal(
    loaded,
    '<skill name="alpha">\nbody of alpha\n</skill>\n\n<skill name="secret">\nSkill "secret" is not available.\n</skill>',
  )
})
