import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { completeChat, toChatMessages } from './chat-completion'
import { forgetEndpointModels } from './endpoint'
import type { AgentSelection } from './types'

function selection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'small',
    apiKey: 'key',
    cwd: '/tmp',
    baseUrl: 'https://example.test/v1',
    ...overrides,
  }
}

// A real Response rather than a hand-rolled stand-in: the AI SDK reads status,
// headers and body itself, and a shape that satisfies this test but not the SDK
// would prove nothing about the wiring.
function respondWith(body: Record<string, unknown>) {
  return mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
}

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'small',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...extra,
  }
}

function sentBody(fetched: ReturnType<typeof respondWith>) {
  const init = fetched.mock.calls[0]?.arguments[1] as { body?: string } | undefined
  return JSON.parse(init?.body ?? '{}')
}

test.beforeEach(() => forgetEndpointModels())
test.afterEach(() => mock.restoreAll())

// ── who may use this at all ────────────────────────────────────────────────

// An ACP agent is a subprocess speaking a protocol over stdio. There is no
// endpoint to post to, so the refusal has to be explicit — silently reaching
// for the provider's OpenAI URL would answer from a different model than the
// profile names.
test('an ACP selection is refused rather than posted to some other endpoint', async () => {
  const fetched = respondWith(completion('never asked'))
  await assert.rejects(
    () => completeChat({ selection: selection({ adapterId: 'claude' }), messages: [{ role: 'user', text: 'hi' }] }),
    /in-process native harness/,
  )
  assert.equal(fetched.mock.callCount(), 0)
})

// ── what reaches the endpoint ──────────────────────────────────────────────

test("the caller's system prompt is what gets sent, not the profile's", async () => {
  const fetched = respondWith(completion('ok'))
  await completeChat({
    selection: selection({ systemPrompt: "the profile's own prompt" }),
    system: 'composed by the host',
    messages: [{ role: 'user', text: 'hi' }],
  })
  const messages = sentBody(fetched).messages as { role: string; content: string }[]
  assert.deepEqual(messages, [
    { role: 'system', content: 'composed by the host' },
    { role: 'user', content: 'hi' },
  ])
})

test("the profile's prompt still stands in when the caller composes none", async () => {
  const fetched = respondWith(completion('ok'))
  await completeChat({
    selection: selection({ systemPrompt: "the profile's own prompt" }),
    messages: [{ role: 'user', text: 'hi' }],
  })
  const [first] = sentBody(fetched).messages as { role: string; content: string }[]
  assert.deepEqual(first, { role: 'system', content: "the profile's own prompt" })
})

// The per-call override is how one conversation is run past a cheaper model
// without editing the profile every other step depends on.
test('a per-call model override reaches the endpoint without touching the profile', async () => {
  const fetched = respondWith(completion('ok'))
  const profile = selection()
  await completeChat({ selection: profile, model: 'large', messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(sentBody(fetched).model, 'large')
  assert.equal(profile.model, 'small')
})

// A caller closing a conversation on an empty user turn is asking the model for
// a new message rather than a continuation of the assistant's last one. That
// only works if the empty turn actually reaches the endpoint, so nothing here
// may treat "no text" as "no message".
test('an empty user turn is sent, not dropped for having no text', async () => {
  const fetched = respondWith(completion('ok'))
  await completeChat({
    selection: selection(),
    messages: [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'a reply' },
      { role: 'user', text: '' },
    ],
  })
  const messages = sentBody(fetched).messages as { role: string; content: string }[]
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'a reply' },
    { role: 'user', content: '' },
  ])
})

test('no tools are offered: this is one request, not an agent loop', async () => {
  const fetched = respondWith(completion('ok'))
  await completeChat({ selection: selection(), messages: [{ role: 'user', text: 'hi' }] })
  const body = sentBody(fetched)
  assert.equal(body.tools, undefined)
})

// ── what comes back ────────────────────────────────────────────────────────

test('usage the endpoint reports comes back as input and output totals', async () => {
  respondWith(completion('answer', { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }))
  const result = await completeChat({ selection: selection(), messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(result.text, 'answer')
  assert.deepEqual(result.usage, { input: 11, output: 7 })
})

// Absent, not zero: an endpoint that omits usage leaves it unknown, and a
// reported {0, 0} would read as a request that cost nothing.
test('usage the endpoint omits is left absent rather than reported as zero', async () => {
  respondWith(completion('answer'))
  const result = await completeChat({ selection: selection(), messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(result.usage, undefined)
})

// ── reading a session's history back ───────────────────────────────────────

// Lossy on purpose. A caller reading history to feed another completion wants
// what was said; the event log keeps the tool detail for anything that needs it.
test('history keeps what was said and drops the tool traffic around it', () => {
  const records = toChatMessages([
    { role: 'user', content: 'draw me a house' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'on it' },
        { type: 'tool-call', toolCallId: '1', toolName: 'a_tool', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: '1', toolName: 'a_tool', output: { type: 'text', value: 'done' } }],
    },
  ])
  assert.deepEqual(records, [
    { role: 'user', text: 'draw me a house' },
    { role: 'assistant', text: 'on it' },
  ])
})

test('a message left with no text after dropping its parts is omitted entirely', () => {
  const records = toChatMessages([
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'x', input: {} }] },
    { role: 'user', content: 'still here' },
  ])
  assert.deepEqual(records, [{ role: 'user', text: 'still here' }])
})
