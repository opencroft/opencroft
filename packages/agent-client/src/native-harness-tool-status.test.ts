import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import type { SessionNotification } from '@agentclientprotocol/sdk'

import type { LocalTool } from './mcp-server'
import { createNativeHarness, type NativeSession } from './native-harness'
import type { AgentSelection } from './types'

// How the Custom harness settles a host tool's call: an answer the tool marks
// as an error, and a call the session refuses, settle `failed`; a plain answer
// settles `completed`. Each runs a real turn against a local OpenAI-compatible
// endpoint whose first answer calls the tool named, and whose second closes.

function sse(res: ServerResponse, delta: Record<string, unknown>, finish: string | null): void {
  res.write(
    `data: ${JSON.stringify({
      id: 'chunk',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  )
}

async function startEndpoint(toolName: string) {
  const { createServer } = await import('node:http')
  const bodies: Record<string, unknown>[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (bodies.length === 1) {
        sse(
          res,
          {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '{}' } }],
          },
          null,
        )
        sse(res, {}, 'tool_calls')
      } else {
        sse(res, { role: 'assistant', content: 'done' }, null)
        sse(res, {}, 'stop')
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the fake endpoint did not bind a port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const TOOLS: LocalTool[] = [
  { name: 'works', description: 'Answers.', inputSchema: {}, handler: () => 'all good' },
  {
    name: 'breaks',
    description: 'Answers with an error.',
    inputSchema: {},
    handler: () => ({ content: [{ type: 'text', text: 'Command exited with code 3' }], isError: true }),
  },
]

/**
 * The settling update the turn reported for the call, and what the model was
 * told. `answer` is the option the user picks when the mode asks first.
 */
async function runCall(toolName: string, mode: string, answer = 'allow') {
  const endpoint = await startEndpoint(toolName)
  const updates: SessionNotification['update'][] = []
  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification.update)
    },
    requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: answer } }),
  } as unknown as Parameters<typeof createNativeHarness>[0]
  const selection: AgentSelection = {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: process.cwd(),
    baseUrl: endpoint.baseUrl,
  }
  const sessions = new Map<string, NativeSession>()
  const harness = createNativeHarness(client, selection, { tools: TOOLS, skills: [] }, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const session = sessions.get(sessionId)
    assert.ok(session)
    session.mode = mode
    await harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    const settled = updates.find((update) => update.sessionUpdate === 'tool_call_update')
    const messages = (endpoint.bodies[1]?.messages ?? []) as { role: string; content: unknown }[]
    const told = messages.find((message) => message.role === 'tool')?.content
    return {
      status: settled && 'status' in settled ? settled.status : undefined,
      output: settled && 'rawOutput' in settled ? settled.rawOutput : undefined,
      told: typeof told === 'string' ? told : JSON.stringify(told),
    }
  } finally {
    await endpoint.close()
  }
}

const WAITS = { timeout: 10_000 }

test('a host tool that answers plainly settles completed', WAITS, async () => {
  const call = await runCall('works', 'bypass')
  assert.equal(call.status, 'completed')
  assert.equal(call.output, 'all good')
})

test('a host tool that answers with an error settles failed, and the model gets the same text', WAITS, async () => {
  const call = await runCall('breaks', 'bypass')
  assert.equal(call.status, 'failed')
  assert.equal(call.output, 'Command exited with code 3')
  assert.match(call.told, /Command exited with code 3/)
})

test('a call the session refuses settles failed, and the model is told it was refused', WAITS, async () => {
  const call = await runCall('works', 'reject-edits')
  assert.equal(call.status, 'failed')
  assert.match(String(call.output), /Permission denied/)
  assert.match(call.told, /Permission denied/)
})

test('a call the user rejects settles failed, and the model is told to stop and ask', WAITS, async () => {
  const call = await runCall('works', 'manual-edits', 'reject')
  const sentence = "The user denied this call. Stop and ask them what to do instead; don't retry it or work around it."
  assert.equal(call.status, 'failed')
  assert.equal(call.output, sentence)
  assert.ok(call.told.includes(sentence), `the model was told: ${call.told}`)
})

test('a call the user allows at the prompt runs', WAITS, async () => {
  const call = await runCall('works', 'manual-edits', 'allow')
  assert.equal(call.status, 'completed')
  assert.equal(call.output, 'all good')
})
