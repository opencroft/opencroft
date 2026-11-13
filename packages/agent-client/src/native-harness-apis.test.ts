import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import test from 'node:test'

import { forgetEndpointModels, MESSAGES_MAX_OUTPUT_TOKENS } from './endpoint'
import { createNativeHarness, type NativeSession } from './native-harness'
import { PICTURE_TOOLS, RED, startRecordingEndpoint } from './test-fixtures/picture-tools'
import type { AgentSelection } from './types'

// What the Responses and the Anthropic Messages requests carry after a step
// whose tool returned a picture. Each case runs a real turn against a local
// endpoint speaking that API's stream: its first answer calls the tool named,
// its second closes the turn, and the second request is the one read.

function event(res: ServerResponse, data: Record<string, unknown>): void {
  res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`)
}

const RESPONSES_USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
}

function responsesAnswer(toolName: string) {
  return (res: ServerResponse, index: number) => {
    event(res, { type: 'response.created', response: { id: `resp_${index}`, created_at: 0, model: 'test-model' } })
    if (index === 0) {
      const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: toolName, arguments: '{}' }
      event(res, { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } })
      event(res, { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{}' })
      event(res, { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed' } })
    } else {
      const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed' }
      event(res, { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } })
      event(res, {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'done',
        logprobs: [],
      })
      event(res, {
        type: 'response.output_item.done',
        output_index: 0,
        item: { ...message, content: [{ type: 'output_text', text: 'done', annotations: [], logprobs: [] }] },
      })
    }
    event(res, { type: 'response.completed', response: { incomplete_details: null, usage: RESPONSES_USAGE } })
  }
}

function messagesAnswer(toolName: string) {
  return (res: ServerResponse, index: number) => {
    event(res, {
      type: 'message_start',
      message: {
        id: `msg_${index}`,
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    if (index === 0) {
      event(res, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} },
      })
      event(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
    } else {
      event(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
    }
    event(res, { type: 'content_block_stop', index: 0 })
    event(res, {
      type: 'message_delta',
      delta: { stop_reason: index === 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    })
    event(res, { type: 'message_stop' })
  }
}

function chatChunk(res: ServerResponse, delta: Record<string, unknown>, finish: string | null): void {
  const chunk = { id: 'chunk', object: 'chat.completion.chunk', created: 0, model: 'test-model' }
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
}

function chatAnswer(toolName: string) {
  return (res: ServerResponse, index: number) => {
    if (index === 0) {
      const call = { index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: '{}' } }
      chatChunk(res, { role: 'assistant', tool_calls: [call] }, null)
      chatChunk(res, {}, 'tool_calls')
    } else {
      chatChunk(res, { role: 'assistant', content: 'done' }, null)
      chatChunk(res, {}, 'stop')
    }
    res.write('data: [DONE]\n\n')
  }
}

type Api = 'responses' | 'anthropic-messages' | 'anthropic-base-url'

const ANSWERS: Record<Api, (toolName: string) => (res: ServerResponse, index: number) => void> = {
  responses: responsesAnswer,
  'anthropic-messages': messagesAnswer,
  'anthropic-base-url': chatAnswer,
}

async function runTurn(api: Api, toolName: string, over: Partial<AgentSelection> = {}) {
  forgetEndpointModels()
  const endpoint = await startRecordingEndpoint(
    [{ id: 'test-model', architecture: { input_modalities: ['text', 'image'] } }],
    ANSWERS[api](toolName),
  )
  const base = { adapterId: 'native', model: 'test-model', apiKey: 'test-key', cwd: process.cwd() }
  const selections: Record<Api, AgentSelection> = {
    responses: {
      ...base,
      providerId: 'openai-compatible',
      baseUrl: `${endpoint.origin}/v1`,
      responsesApi: true,
      nativeApi: 'responses',
    },
    'anthropic-messages': {
      ...base,
      providerId: 'anthropic',
      baseUrl: endpoint.origin,
      nativeApi: 'anthropic-messages',
    },
    // A Custom profile on the Anthropic provider that names no API and points
    // its Base URL at an OpenAI-compatible server.
    'anthropic-base-url': { ...base, providerId: 'anthropic', baseUrl: `${endpoint.origin}/v1` },
  }
  const selection: AgentSelection = { ...selections[api], ...over }
  const client = { sessionUpdate: async () => {} } as unknown as Parameters<typeof createNativeHarness>[0]
  const harness = createNativeHarness(
    client,
    selection,
    { tools: PICTURE_TOOLS, skills: [] },
    new Map<string, NativeSession>(),
  )
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.setSessionMode?.({ sessionId, modeId: 'bypass' })
    const result = await harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'look' }] })
    return { result, requests: endpoint.requests }
  } finally {
    await endpoint.close()
  }
}

// ── Responses ──────────────────────────────────────────────────────────────

test('Responses: a picture travels inside the function call output, with no message added', async () => {
  const { result, requests } = await runTurn('responses', 'view_red')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].path, '/v1/responses')
  const input = requests[1].body.input as Record<string, unknown>[]
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ['user', 'function_call', 'function_call_output'],
  )
  assert.deepEqual(input[2], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: [
      { type: 'input_text', text: 'red.png, 1×1' },
      { type: 'input_image', image_url: `data:image/png;base64,${RED}` },
    ],
  })
})

test('Responses: nothing is stored on the provider, and only a reasoning model asks for its reasoning back', async () => {
  const plain = await runTurn('responses', 'say')
  for (const request of plain.requests) {
    assert.equal(request.body.store, false)
    assert.equal(Object.hasOwn(request.body, 'include'), false)
  }
  const reasoning = await runTurn('responses', 'say', { model: 'gpt-5' })
  assert.equal(reasoning.requests.length, 2)
  for (const request of reasoning.requests) {
    assert.equal(request.body.model, 'gpt-5')
    assert.equal(request.body.store, false)
    assert.deepEqual(request.body.include, ['reasoning.encrypted_content'])
  }
})

test('Responses: a text answer stays a plain string, and a text-only model gets a line for the picture', async () => {
  const words = await runTurn('responses', 'say')
  const wordsInput = words.requests[1].body.input as Record<string, unknown>[]
  assert.deepEqual(wordsInput[2], { type: 'function_call_output', call_id: 'call_1', output: 'just words' })

  const textOnly = await runTurn('responses', 'view_red', { imageInput: false })
  const textOnlyInput = textOnly.requests[1].body.input as Record<string, unknown>[]
  assert.deepEqual(textOnlyInput[2], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'red.png, 1×1\n[image image/png, 70 B, not shown: this model does not take images]',
  })
  assert.doesNotMatch(JSON.stringify(textOnly.requests), /input_image/)
})

// ── Anthropic Messages ─────────────────────────────────────────────────────

test('Messages: a picture travels as an image block inside the tool result, with no message added', async () => {
  const { result, requests } = await runTurn('anthropic-messages', 'view_red')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].path, '/v1/messages')
  const messages = requests[1].body.messages as { role: string; content: Record<string, unknown>[] }[]
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(messages[2].content.length, 1)
  assert.deepEqual(messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: [
      { type: 'text', text: 'red.png, 1×1' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED } },
    ],
  })
})

test('Messages: the key goes as a Bearer token and the output cap is stated', async () => {
  const { requests } = await runTurn('anthropic-messages', 'say')
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Bearer test-key')
    assert.equal(request.headers['x-api-key'], undefined)
    assert.equal(request.body.max_tokens, MESSAGES_MAX_OUTPUT_TOKENS)
  }
})

test('Messages: a text answer stays a plain string, and a text-only model gets a line for the picture', async () => {
  const words = await runTurn('anthropic-messages', 'say_envelope')
  const wordsMessages = words.requests[1].body.messages as { content: Record<string, unknown>[] }[]
  assert.deepEqual(wordsMessages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: 'first line\nsecond line',
  })

  const textOnly = await runTurn('anthropic-messages', 'view_red', { imageInput: false })
  const textOnlyMessages = textOnly.requests[1].body.messages as { content: Record<string, unknown>[] }[]
  assert.deepEqual(textOnlyMessages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: 'red.png, 1×1\n[image image/png, 70 B, not shown: this model does not take images]',
  })
  assert.doesNotMatch(JSON.stringify(textOnly.requests), /"type":"image"/)
})

// ── A Base URL with no API named ───────────────────────────────────────────

test('an Anthropic-provider profile with a Base URL and no API named runs on Chat Completions at that URL', async () => {
  const { result, requests } = await runTurn('anthropic-base-url', 'view_red')
  assert.equal(result.stopReason, 'end_turn')
  assert.deepEqual(
    requests.map((request) => request.path),
    ['/v1/chat/completions', '/v1/chat/completions'],
  )
  assert.equal(requests[1].headers.authorization, 'Bearer test-key')
  const messages = requests[1].body.messages as { role: string; content: unknown }[]
  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'user'],
  )
  assert.match(String(messages[2].content), /^red\.png, 1×1\n\[image image\/png, 70 B, attached/)
})
