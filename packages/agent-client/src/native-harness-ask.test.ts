import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'

import type { ToolsCaller } from './mcp-server'
import { ASK_USER_TOOL_NAME, createNativeHarness, type NativeSession } from './native-harness'
import type { ResolvedPermissions } from './permissions'
import type { AgentSelection } from './types'

// The Custom harness asks the way an ACP agent does: its own ask_user tool
// sends a form elicitation through the client and the turn waits on it. These
// run a real turn against a local OpenAI-compatible endpoint whose first answer
// is a call to ask_user, so what is checked is what the model's call does.

const QUESTIONS = [{ title: 'Colour', question: 'Which colour?', options: ['Red', 'Blue'] }]

interface AskEndpoint {
  baseUrl: string
  /** Every request body, parsed, in order. */
  bodies: Record<string, unknown>[]
  close: () => Promise<void>
}

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

/** First request: a call to ask_user. Every later one: a short closing text. */
async function startAskEndpoint(): Promise<AskEndpoint> {
  const { createServer } = await import('node:http')
  const bodies: Record<string, unknown>[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      // The model discovery a session asks at its start: nothing to report.
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
            tool_calls: [
              {
                index: 0,
                id: 'call_ask',
                type: 'function',
                function: { name: ASK_USER_TOOL_NAME, arguments: JSON.stringify({ questions: QUESTIONS }) },
              },
            ],
          },
          null,
        )
        sse(res, {}, 'tool_calls')
      } else {
        sse(res, { role: 'assistant', content: 'thanks' }, null)
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

interface Harness {
  harness: ReturnType<typeof createNativeHarness>
  /** Elicitations the harness sent, each with the way to answer it. */
  asked: { request: CreateElicitationRequest; answer: (response: CreateElicitationResponse) => void }[]
  /** Resolves when the next elicitation arrives. */
  nextAsk: () => Promise<void>
  callers: ToolsCaller[]
}

function harnessFor(endpoint: AskEndpoint, sessions: Map<string, NativeSession>): Harness {
  const asked: Harness['asked'] = []
  let announce: () => void = () => {}
  const client = {
    sessionUpdate: async () => {},
    createElicitation: (request: CreateElicitationRequest) =>
      new Promise<CreateElicitationResponse>((answer) => {
        asked.push({ request, answer })
        announce()
      }),
  } as unknown as Parameters<typeof createNativeHarness>[0]
  const selection: AgentSelection = {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: process.cwd(),
    baseUrl: endpoint.baseUrl,
  }
  const callers: ToolsCaller[] = []
  const tools = async (caller: ToolsCaller) => {
    callers.push(caller)
    return []
  }
  const harness = createNativeHarness(client, selection, { tools, skills: [] }, sessions)
  const nextAsk = () =>
    new Promise<void>((resolve) => {
      announce = resolve
    })
  return { harness, asked, nextAsk, callers }
}

/** The tool result the model was sent back for the call, from the second request. */
function toolResultText(body: Record<string, unknown> | undefined): string {
  const messages = (body?.messages ?? []) as { role: string; content: unknown }[]
  const result = messages.find((message) => message.role === 'tool')
  return typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content)
}

// Each test waits on a question being asked; one that never is fails here
// rather than holding the run open.
const WAITS = { timeout: 10_000 }

test('the question goes out as a form elicitation on its own session, and the turn waits for it', WAITS, async () => {
  const endpoint = await startAskEndpoint()
  const sessions = new Map<string, NativeSession>()
  const h = harnessFor(endpoint, sessions)
  try {
    const { sessionId } = await h.harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const asking = h.nextAsk()
    let settled = false
    const turn = h.harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] }).finally(() => {
      settled = true
    })
    await asking

    const [ask] = h.asked
    assert.ok(ask)
    assert.equal(ask.request.mode, 'form')
    assert.equal((ask.request as { sessionId?: string }).sessionId, sessionId)
    assert.equal(ask.request.message, 'Which colour?')

    // Held well past the moment the call was made: nothing but the answer
    // ends this wait.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(settled, false, 'the turn is still waiting on the answer')
    assert.equal(endpoint.bodies.length, 1, 'and the model has not been called again meanwhile')

    ask.answer({ action: 'accept', content: { question_0: 'Blue' } })
    const { stopReason } = await turn
    assert.equal(stopReason, 'end_turn')
    assert.equal(endpoint.bodies.length, 2, 'the answer went back into the same turn')
    assert.match(toolResultText(endpoint.bodies[1]), /"Which colour\?"="Blue"/)
  } finally {
    await endpoint.close()
  }
})

test('a dismissed question tells the model so, rather than inventing an answer', WAITS, async () => {
  const endpoint = await startAskEndpoint()
  const h = harnessFor(endpoint, new Map())
  try {
    const { sessionId } = await h.harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const asking = h.nextAsk()
    const turn = h.harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] })
    await asking
    h.asked[0]?.answer({ action: 'decline' })
    await turn
    assert.match(toolResultText(endpoint.bodies[1]), /dismissed the question without answering/)
  } finally {
    await endpoint.close()
  }
})

test('stopping the turn while the question is open ends the turn at once', WAITS, async () => {
  const endpoint = await startAskEndpoint()
  const sessions = new Map<string, NativeSession>()
  const h = harnessFor(endpoint, sessions)
  try {
    const { sessionId } = await h.harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const asking = h.nextAsk()
    const turn = h.harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] })
    await asking

    await h.harness.cancel({ sessionId })
    const { stopReason } = await turn
    assert.equal(stopReason, 'cancelled')
    assert.equal(sessions.get(sessionId)?.abort, undefined, 'the session takes the next prompt')
    assert.equal(endpoint.bodies.length, 1, 'nothing was sent to the model after the stop')
  } finally {
    await endpoint.close()
  }
})

test('the model is offered ask_user, unless the role hides it', WAITS, async () => {
  const offered = async (permissions?: ResolvedPermissions) => {
    const endpoint = await startAskEndpoint()
    const sessions = new Map<string, NativeSession>()
    const h = harnessFor(endpoint, sessions)
    try {
      const { sessionId } = await h.harness.newSession({ cwd: process.cwd(), mcpServers: [] })
      const session = sessions.get(sessionId)
      if (session && permissions) {
        session.permissions = permissions
      }
      const asking = h.nextAsk()
      // A hidden tool cannot be called: the model's call to it fails however
      // the SDK reports that, and no question is asked.
      const turn = h.harness
        .prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] })
        .catch(() => ({ stopReason: 'failed' }))
      await Promise.race([asking, turn])
      h.asked[0]?.answer({ action: 'accept', content: { question_0: 'Red' } })
      await turn
      const tools = (endpoint.bodies[0]?.tools ?? []) as { function?: { name?: string } }[]
      return tools.some((tool) => tool.function?.name === ASK_USER_TOOL_NAME)
    } finally {
      await endpoint.close()
    }
  }
  assert.equal(await offered(), true)
  // A role that grants nothing by name: every tool it does not list is hidden.
  assert.equal(await offered({ mode: 'scoped', allow: {}, defaultAccess: 'Allow' }), false)
})

test('host tools are listed for the calling session and harness', WAITS, async () => {
  const endpoint = await startAskEndpoint()
  const h = harnessFor(endpoint, new Map())
  try {
    const { sessionId } = await h.harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const asking = h.nextAsk()
    const turn = h.harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'ask me' }] })
    await asking
    h.asked[0]?.answer({ action: 'accept', content: { question_0: 'Red' } })
    await turn
    assert.equal(h.callers[0]?.sessionId, sessionId)
    assert.equal(h.callers[0]?.adapterId, 'native')
  } finally {
    await endpoint.close()
  }
})
