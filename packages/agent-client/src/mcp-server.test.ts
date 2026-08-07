import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpServer, type LocalTool, type ToolsCaller } from './mcp-server'

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
