import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import { forgetEndpointModels } from './endpoint'
import { createNativeHarness, type NativeSession } from './native-harness'
import { BLUE, PICTURE_TOOLS, RED } from './test-fixtures/picture-tools'
import type { AgentSelection } from './types'

// What a Chat Completions request carries after a step whose tools returned
// pictures. Each case runs real turns against a local OpenAI-compatible
// endpoint: its model list says what the model takes, its first answer calls
// the tools named in one step, and its later answers close the turn.


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

interface ChatBody {
  messages: { role: string; content: unknown; tool_call_id?: string }[]
}

// `modalities` is what the model list reports for `test-model`, or undefined
// for an entry that reports nothing.
async function startEndpoint(toolNames: string[], modalities: string[] | undefined) {
  const { createServer } = await import('node:http')
  const bodies: ChatBody[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        const entry = modalities ? { id: 'test-model', architecture: { input_modalities: modalities } } : { id: 'test-model' }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [entry] }))
        return
      }
      bodies.push(JSON.parse(raw) as ChatBody)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (bodies.length === 1 && toolNames.length > 0) {
        sse(
          res,
          {
            role: 'assistant',
            tool_calls: toolNames.map((name, index) => ({
              index,
              id: `call_${index + 1}`,
              type: 'function',
              function: { name, arguments: '{}' },
            })),
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


async function runTurn(
  toolNames: string[],
  modalities: string[] | undefined,
  over: Partial<AgentSelection> = {},
  sessions = new Map<string, NativeSession>(),
) {
  forgetEndpointModels()
  const endpoint = await startEndpoint(toolNames, modalities)
  const selection: AgentSelection = {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: process.cwd(),
    baseUrl: endpoint.baseUrl,
    ...over,
  }
  const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof createNativeHarness>[0]
  const harness = createNativeHarness(client, selection, { tools: PICTURE_TOOLS, skills: [] }, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.setSessionMode?.({ sessionId, modeId: 'bypass' })
    const result = await harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'look' }] })
    return { result, bodies: endpoint.bodies, session: sessions.get(sessionId) as NativeSession }
  } finally {
    await endpoint.close()
  }
}

test('a vision model gets the step’s pictures in one user message after the tool results, in call order', async () => {
  const { result, bodies } = await runTurn(['view_red', 'view_blue'], ['text', 'image'])
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(bodies.length, 2)
  const sent = bodies[1].messages
  assert.deepEqual(
    sent.map((message) => message.role),
    ['user', 'assistant', 'tool', 'tool', 'user'],
  )
  const toolText = Object.fromEntries(sent.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]))
  assert.equal(toolText.call_1, 'red.png, 1×1\n[image image/png, 70 B, attached in the message after the tool results]')
  assert.equal(toolText.call_2, 'blue.jpg, 1×1\n[image image/jpeg, 139 B, attached in the message after the tool results]')
  assert.deepEqual(sent[4].content, [
    { type: 'text', text: 'The images returned by the tool calls above, in the order they were called.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${RED}` } },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${BLUE}` } },
  ])
})

test('a model the endpoint reports as text-only gets a line in place of each picture, and no picture at all', async () => {
  const { bodies } = await runTurn(['view_red'], ['text'])
  const sent = bodies[1].messages
  assert.deepEqual(
    sent.map((message) => message.role),
    ['user', 'assistant', 'tool'],
  )
  assert.equal(sent[2].content, 'red.png, 1×1\n[image image/png, 70 B, not shown: this model does not take images]')
  assert.doesNotMatch(JSON.stringify(bodies), /base64|image_url/)
})

test('a model the endpoint reports nothing about is sent no picture', async () => {
  const { bodies } = await runTurn(['view_red'], undefined)
  assert.equal(bodies[1].messages.length, 3)
  assert.equal(
    bodies[1].messages[2].content,
    'red.png, 1×1\n[image image/png, 70 B, not shown: this model does not take images]',
  )
  assert.doesNotMatch(JSON.stringify(bodies), /image_url/)
})

test('the profile setting outranks what the endpoint reports, either way', async () => {
  const pinnedOn = await runTurn(['view_red'], undefined, { imageInput: true })
  assert.match(JSON.stringify(pinnedOn.bodies[1].messages.at(-1)), /data:image\/png;base64,/)
  const pinnedOff = await runTurn(['view_red'], ['text', 'image'], { imageInput: false })
  assert.doesNotMatch(JSON.stringify(pinnedOff.bodies), /image_url/)
})

test('text answers reach the model as plain strings, a plain one and an envelope alike', async () => {
  for (const modalities of [['text', 'image'], ['text']]) {
    const { bodies } = await runTurn(['say', 'say_envelope'], modalities)
    const sent = bodies[1].messages
    assert.deepEqual(
      sent.filter((m) => m.role === 'tool').map((m) => m.content),
      ['just words', 'first line\nsecond line'],
    )
    assert.equal(sent.length, 4)
  }
})

test('the stored conversation keeps the pictures inside their tool results, and the next turn sends them again', async () => {
  const sessions = new Map<string, NativeSession>()
  const first = await runTurn(['view_red'], ['text', 'image'], {}, sessions)
  const tool = first.session.messages.find((message) => message.role === 'tool')
  assert.ok(tool && tool.role === 'tool')
  const output = tool.content[0].type === 'tool-result' ? tool.content[0].output : undefined
  assert.deepEqual(output, {
    type: 'content',
    value: [
      { type: 'text', text: 'red.png, 1×1' },
      { type: 'image-data', data: RED, mediaType: 'image/png' },
    ],
  })
  // The later request is shaped from the stored form again, the picture
  // after the result it came in.
  forgetEndpointModels()
  const endpoint = await startEndpoint([], ['text', 'image'])
  try {
    const sessionId = [...sessions.keys()][0]
    const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof createNativeHarness>[0]
    const harness = createNativeHarness(
      client,
      {
        providerId: 'openai-compatible',
        adapterId: 'native',
        model: 'test-model',
        apiKey: 'test-key',
        cwd: process.cwd(),
        baseUrl: endpoint.baseUrl,
      },
      { tools: PICTURE_TOOLS, skills: [] },
      sessions,
    )
    await harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'and now?' }] })
    assert.deepEqual(
      endpoint.bodies[0].messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'user', 'assistant', 'user'],
    )
    assert.match(JSON.stringify(endpoint.bodies[0].messages[3]), /data:image\/png;base64,/)
  } finally {
    await endpoint.close()
  }
})
