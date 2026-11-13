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

test("a client dropping a tool call's request aborts the handler's signal", { timeout: 10_000 }, async () => {
  // What a client that gives up on a call does (Copilot at its MCP request
  // timeout): it closes the request and sends a cancel as a request of its
  // own. Only the first can reach the handler, whose request has its own
  // transport, so that is what this does.
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let aborted: () => void = () => {}
  const abortSeen = new Promise<void>((resolve) => {
    aborted = resolve
  })
  const tools: LocalTool[] = [
    {
      name: 'wait',
      description: 'waits until its caller gives up',
      inputSchema: {},
      handler: (_args, context) =>
        new Promise((resolve) => {
          assert.ok(context?.signal, 'the handler gets a signal')
          context.signal.addEventListener('abort', () => {
            aborted()
            resolve({ content: [{ type: 'text', text: 'gave up' }] })
          })
          started()
        }),
    },
  ]
  const handle = createMcpServer({ name: `abort-${crypto.randomUUID()}`, tools, skills: [] })
  const client = new AbortController()
  try {
    const call = fetch(await handle.ensureUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } }),
      signal: client.signal,
    })
    await running
    client.abort()
    await assert.rejects(call)
    await abortSeen
  } finally {
    await handle.close()
  }
})

test('an image block a tool returns reaches the MCP client unchanged', async () => {
  // What lets an agent behind this server SEE a picture a tool fetched: the
  // block has to arrive as an image, with its bytes and type intact, not be
  // flattened to text on the way.
  const result = {
    content: [
      { type: 'text', text: 'shot.png: PNG, 1×1' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    ],
  }
  const tools: LocalTool[] = [
    { name: 'view', description: 'returns a picture', inputSchema: {}, handler: async () => result },
  ]
  const handle = createMcpServer({ name: `image-result-${crypto.randomUUID()}`, tools, skills: [] })
  try {
    const response = await fetch(await handle.ensureUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'view', arguments: {} } }),
    })
    const body = (await response.json()) as { result?: { content?: unknown } }
    assert.deepEqual(body.result?.content, result.content)
  } finally {
    await handle.close()
  }
})

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
