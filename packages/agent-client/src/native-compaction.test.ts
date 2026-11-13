import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { jsonSchema, tool } from 'ai'

import { createAgentClient } from './agent-client'
import {
  compactCommand,
  fixedLength,
  readingAfter,
  shouldAutoCompact,
  tokensPerCharacter,
  transcriptText,
} from './native-compaction'
import { createNativeHarness, type NativeSession } from './native-harness'
import type { AgentSelection, ChatEvent } from './types'

test('/compact is recognised alone and with focus instructions, and nothing else is', () => {
  assert.equal(compactCommand('/compact'), '')
  assert.equal(compactCommand('/compact  keep the API names\n'), 'keep the API names')
  assert.equal(compactCommand('/compacted'), null)
  assert.equal(compactCommand('please /compact'), null)
  assert.equal(compactCommand('/clear'), null)
})

const configured = (size: number) => ({ size, configured: true })
const reported = (size: number) => ({ size, configured: false })

test('a configured window compacts once the context fills all of it', () => {
  assert.equal(shouldAutoCompact(999, configured(1000)), false)
  assert.equal(shouldAutoCompact(1000, configured(1000)), true)
  assert.equal(shouldAutoCompact(1200, configured(1000)), true)
})

test('a reported window compacts at the ratio, leaving the summary the rest of it', () => {
  assert.equal(shouldAutoCompact(799, reported(1000)), false)
  assert.equal(shouldAutoCompact(800, reported(1000)), true)
})

test('an unknown window or reading never compacts', () => {
  assert.equal(shouldAutoCompact(1_000_000, configured(0)), false)
  assert.equal(shouldAutoCompact(1_000_000, reported(0)), false)
  assert.equal(shouldAutoCompact(undefined, configured(1000)), false)
})

test('after a compaction that left plenty of room, the bar alone decides the next one', () => {
  assert.equal(shouldAutoCompact(47_999, reported(60_000), 1_000), false)
  assert.equal(shouldAutoCompact(48_000, reported(60_000), 1_000), true)
  assert.equal(shouldAutoCompact(59_999, configured(60_000), 1_000), false)
  assert.equal(shouldAutoCompact(60_000, configured(60_000), 1_000), true)
})

test('after a compaction that left the context past the ratio, the next waits for half the room it left', () => {
  // A compaction left 15800 of 19000: past the ratio's 15200, 3200 of room.
  assert.equal(shouldAutoCompact(15_900, reported(19_000)), true, 'precondition: past the ratio')
  assert.equal(shouldAutoCompact(15_900, reported(19_000), 15_800), false)
  assert.equal(shouldAutoCompact(17_399, reported(19_000), 15_800), false)
  assert.equal(shouldAutoCompact(17_400, reported(19_000), 15_800), true)
})

test('after a compaction that left no room in the window, none follows on its own', () => {
  assert.equal(shouldAutoCompact(1_300, configured(1000), 1_100), false)
  assert.equal(shouldAutoCompact(1_000_000, configured(1000), 1000), false)
  assert.equal(shouldAutoCompact(1_000_000, reported(1000), 1000), false)
  assert.equal(shouldAutoCompact(1000, configured(1000), 999), true, 'one token of room is room')
})

test('the reading after a compaction is the kept part plus the summary', () => {
  assert.equal(readingAfter(15_000, { outputTokens: 50 }), 15_050)
  assert.equal(readingAfter(undefined, { outputTokens: 50 }), undefined, 'no estimate of the kept part, no reading')
  assert.equal(readingAfter(15_000, {}), undefined)
})

test('the reading after a compaction counts the summary, not the reasoning that wrote it', () => {
  assert.equal(readingAfter(15_000, { outputTokens: 850, outputTokenDetails: { textTokens: 50 } }), 15_050)
})

test('the fixed part is the system prompt and each tool as declared', async () => {
  const schema = { type: 'object' as const, properties: { q: { type: 'string' as const } } }
  const tools = { search: tool({ description: 'Search.', inputSchema: jsonSchema(schema) }) }
  assert.equal(
    await fixedLength('Be brief.', tools),
    'Be brief.'.length + 'search'.length + 'Search.'.length + JSON.stringify(schema).length,
  )
})

test("a call's tokens per character count its fixed part and what its messages say", () => {
  // 1000 characters of fixed part and a 200-character prompt measured 400 tokens.
  const prompt = 'x'.repeat(200)
  assert.equal(tokensPerCharacter(400, 1_000, [{ role: 'user', content: prompt }]), 400 / 1_200)
})

test('the transcript carries what was said and what the tools did, as text', () => {
  const text = transcriptText([
    { role: 'user', content: 'find the file' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'private working' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { q: 'x' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 't1', toolName: 'search', output: { type: 'text', value: 'found a.ts' } },
      ],
    },
    { role: 'assistant', content: 'It is a.ts.' },
  ])
  assert.equal(
    text,
    [
      'User: find the file',
      'Agent: [called tool search with {"q":"x"}]',
      'Tool: [tool search returned: found a.ts]',
      'Agent: It is a.ts.',
    ].join('\n\n'),
  )
})

// ---------------------------------------------------------------------------
// The harness against a real streaming endpoint on localhost, scripted one
// answer per request, so the AI SDK's own step loop and abort handling are what
// is exercised.
// ---------------------------------------------------------------------------

interface Reply {
  text?: string
  /** Streamed as the model's reasoning before the text. */
  reasoning?: string
  toolCall?: string
  /** `reasoning` is the part of `completion` the model spent reasoning. */
  usage?: { prompt: number; completion: number; reasoning?: number }
  status?: number
  /** Stream one chunk and hold the response open until the test ends. */
  hang?: boolean
}

interface RequestBody {
  messages: { role: string; content: unknown }[]
  tools?: { function: { name: string; description?: string; parameters: unknown } }[]
}

/**
 * The estimate of the part a compaction keeps, from the session's first
 * request as the endpoint received it: its system prompt and tool
 * declarations, counted at the tokens per character that request measured
 * (`input` tokens for the fixed part and the first prompt).
 */
function keptEstimate(first: RequestBody, input: number, prompt: string): number {
  const system = first.messages.filter((m) => m.role === 'system').map((m) => String(m.content))
  const fixed = (first.tools ?? []).reduce(
    (sum, t) => sum + t.function.name.length + (t.function.description ?? '').length + JSON.stringify(t.function.parameters).length,
    system.join('').length,
  )
  return Math.round(fixed * (input / (fixed + prompt.length)))
}

const SUMMARY_MARKER = 'You summarise a conversation'

function isSummaryRequest(body: RequestBody): boolean {
  return body.messages.some((m) => m.role === 'system' && String(m.content).startsWith(SUMMARY_MARKER))
}

/** `modelWindow` is the context length `/models` reports for the test model; none when omitted. */
async function startScriptedEndpoint(replies: Reply[], modelWindow?: number) {
  const bodies: RequestBody[] = []
  const open = new Set<ServerResponse>()
  let announceHang: () => void = () => {}
  const hanging = new Promise<void>((resolve) => {
    announceHang = resolve
  })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const models = modelWindow === undefined ? [] : [{ id: 'test-model', context_length: modelWindow }]
        res.end(JSON.stringify({ data: models }))
        return
      }
      bodies.push(JSON.parse(raw) as RequestBody)
      const reply = replies[bodies.length - 1] ?? { text: 'unscripted' }
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'the endpoint refused' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      open.add(res)
      const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Reply['usage']) =>
        `data: ${JSON.stringify({
          id: 'chunk',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage
            ? {
                usage: {
                  prompt_tokens: usage.prompt,
                  completion_tokens: usage.completion,
                  total_tokens: usage.prompt + usage.completion,
                  ...(usage.reasoning === undefined
                    ? {}
                    : { completion_tokens_details: { reasoning_tokens: usage.reasoning } }),
                },
              }
            : {}),
        })}\n\n`
      if (reply.hang) {
        res.write(chunk({ role: 'assistant', content: 'partial ' }, null))
        announceHang()
        return
      }
      if (reply.toolCall) {
        res.write(
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call-1', type: 'function', function: { name: reply.toolCall, arguments: '{}' } },
              ],
            },
            null,
          ),
        )
        res.write(chunk({}, 'tool_calls', reply.usage))
      } else {
        if (reply.reasoning) {
          res.write(chunk({ role: 'assistant', reasoning_content: reply.reasoning }, null))
        }
        res.write(chunk({ role: 'assistant', content: reply.text ?? '' }, null))
        res.write(chunk({}, 'stop', reply.usage))
      }
      res.write('data: [DONE]\n\n')
      res.end()
      open.delete(res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the scripted endpoint did not bind a port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    hanging,
    close: async () => {
      for (const res of open) {
        res.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

type Update = { sessionUpdate: string } & Record<string, unknown>

function harnessFor(
  baseUrl: string,
  sessions: Map<string, NativeSession>,
  /** The profile's configured window; `null` leaves it to the endpoint. */
  contextWindow: number | null = 1000,
  systemPrompt?: string,
) {
  const updates: Update[] = []
  const client = {
    sessionUpdate: async (params: { update: Update }) => {
      updates.push(params.update)
    },
  } as unknown as Parameters<typeof createNativeHarness>[0]
  const selection: AgentSelection = {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: process.cwd(),
    baseUrl,
    ...(contextWindow === null ? {} : { contextWindow }),
    systemPrompt,
  }
  const tools = [{ name: 'probe', description: 'Probe.', inputSchema: {}, handler: () => 'probed' }]
  const harness = createNativeHarness(client, selection, { tools, skills: [] }, sessions)
  return { harness, updates }
}

/** The compaction updates, as `status` (or `chunk`) in arrival order. */
function compactionTrail(updates: Update[]): string[] {
  return updates.flatMap((u) => {
    if (u.sessionUpdate === 'compaction_update') {
      return [String(u.status)]
    }
    return u.sessionUpdate === 'compaction_summary_chunk' ? ['chunk'] : []
  })
}

function lastUsage(updates: Update[]): number | undefined {
  return updates.filter((u) => u.sessionUpdate === 'usage_update').at(-1)?.used as number | undefined
}

const text = (t: string) => [{ type: 'text' as const, text: t }]

test('/compact summarises the conversation, reports it as an ACP bridge does, and the next turn carries on from the summary', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted: the codeword is heron.', usage: { prompt: 400, completion: 20 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 450, completion: 12 } },
    { text: 'heron', usage: { prompt: 60, completion: 2 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember the codeword heron.') })
    assert.equal(lastUsage(updates), 420, 'precondition: the turn reported its reading')

    const compact = await harness.prompt({ sessionId, prompt: text('/compact') })
    assert.equal(compact.stopReason, 'end_turn')
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    const completed = updates.filter((u) => u.sessionUpdate === 'compaction_update').at(-1)
    assert.deepEqual(completed?.summary, text('The user set the codeword heron.'))
    const facts = (completed?._meta as { contextCompaction: Record<string, unknown> }).contextCompaction
    assert.equal(facts.trigger, 'manual')
    assert.equal(facts.preTokens, 420)
    const after = keptEstimate(endpoint.bodies[0], 400, 'Remember the codeword heron.') + 12
    assert.equal(facts.postTokens, after, 'the kept part and the summary')
    assert.equal(lastUsage(updates), after, 'reported the moment the compaction completes')
    assert.ok(isSummaryRequest(endpoint.bodies[1]), 'the summary was written by the model')

    await harness.prompt({ sessionId, prompt: text('What is the codeword?') })
    const next = endpoint.bodies[2]
    assert.equal(next.messages.length, 2, 'the next turn is sent the summary and its own message, nothing else')
    assert.match(String(next.messages[0].content), /codeword heron/)
    assert.equal(next.messages[1].content, 'What is the codeword?')
    assert.equal(lastUsage(updates), 62, "the next turn's measurement replaces the estimate")
  } finally {
    await endpoint.close()
  }
})

test('a failed /compact reports failed with the reason and leaves the conversation as it was', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted.', usage: { prompt: 400, completion: 5 } },
    { status: 400 },
    { text: 'still here', usage: { prompt: 420, completion: 3 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    const before = structuredClone(sessions.get(sessionId)?.messages)

    await harness.prompt({ sessionId, prompt: text('/compact') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'failed'])
    const failed = updates.filter((u) => u.sessionUpdate === 'compaction_update').at(-1)
    assert.match(String(failed?.error), /refused/)
    assert.deepEqual(sessions.get(sessionId)?.messages, before)
    assert.equal(lastUsage(updates), 405, 'no reading claims a shrink')

    await harness.prompt({ sessionId, prompt: text('Still there?') })
    assert.equal(endpoint.bodies[2].messages.length, 3, 'the next turn is sent the whole conversation')
  } finally {
    await endpoint.close()
  }
})

test('a /compact cancelled while the summary is written reports cancelled and releases the session unchanged', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted.', usage: { prompt: 400, completion: 5 } },
    { hang: true },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    const before = structuredClone(sessions.get(sessionId)?.messages)

    const compact = harness.prompt({ sessionId, prompt: text('/compact') })
    await endpoint.hanging
    assert.ok(sessions.get(sessionId)?.abort, 'precondition: the compaction is in flight')
    await harness.cancel({ sessionId })
    assert.equal((await compact).stopReason, 'cancelled')

    // Whether the streamed chunk is read before the cancel lands is a race;
    // the statuses are not.
    assert.deepEqual(
      compactionTrail(updates).filter((step) => step !== 'chunk'),
      ['in_progress', 'cancelled'],
    )
    assert.deepEqual(sessions.get(sessionId)?.messages, before)
    assert.equal(sessions.get(sessionId)?.abort, undefined, 'the session takes the next prompt')
  } finally {
    await endpoint.close()
  }
})

test('/compact on an empty conversation reports one failed compaction', async () => {
  const endpoint = await startScriptedEndpoint([])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('/compact') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'failed'])
    assert.equal(endpoint.bodies.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('a turn that starts with the configured window full compacts the history and sends its prompt as written', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted.', usage: { prompt: 995, completion: 5 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 870, completion: 10 } },
    { text: 'heron', usage: { prompt: 50, completion: 2 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    assert.deepEqual(compactionTrail(updates), [], 'precondition: the first turn did not compact')

    await harness.prompt({ sessionId, prompt: text('What is the codeword?') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    const facts = (
      updates.filter((u) => u.sessionUpdate === 'compaction_update').at(-1)?._meta as {
        contextCompaction: Record<string, unknown>
      }
    ).contextCompaction
    assert.equal(facts.trigger, 'automatic')
    assert.equal(facts.preTokens, 1000)

    const transcript = String(endpoint.bodies[1].messages.at(-1)?.content)
    assert.match(transcript, /Remember heron/)
    assert.doesNotMatch(transcript, /What is the codeword/, 'the new prompt is not summarised')

    const step = endpoint.bodies[2]
    assert.equal(step.messages.length, 2, "the turn's model call is sent the summary, then the prompt")
    assert.match(String(step.messages[0].content), /codeword heron/)
    assert.doesNotMatch(String(step.messages[0].content), /Continue the work/, 'nothing was in progress')
    assert.equal(step.messages[1].content, 'What is the codeword?')
    const stored = sessions.get(sessionId)?.messages ?? []
    assert.deepEqual(
      stored.map((m) => m.role),
      ['user', 'user', 'assistant'],
      'the session keeps the summary, the prompt and the reply',
    )
    assert.equal(stored[1].content, 'What is the codeword?')
    assert.equal(lastUsage(updates), 52)
  } finally {
    await endpoint.close()
  }
})

test('an image in the prompt that triggers the compaction reaches the model as an image', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted.', usage: { prompt: 995, completion: 5 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 870, completion: 10 } },
    { text: 'A heron.', usage: { prompt: 90, completion: 3 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    await harness.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', data: 'aGVyb24=', mimeType: 'image/png' },
      ],
    })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    assert.doesNotMatch(String(endpoint.bodies[1].messages.at(-1)?.content), /\[attachment\]/)

    const prompt = endpoint.bodies[2].messages.at(-1)
    assert.equal(prompt?.role, 'user')
    assert.deepEqual(prompt?.content, [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVyb24=' } },
    ])
  } finally {
    await endpoint.close()
  }
})

test('a turn with no history before its prompt does not compact, whatever the reading', async () => {
  const endpoint = await startScriptedEndpoint([{ text: 'Hello.', usage: { prompt: 10, completion: 2 } }])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    // No session path holds a reading over an empty conversation; set one so
    // the turn's check meets nothing to compact.
    const session = sessions.get(sessionId)
    assert.ok(session)
    session.contextUsed = 1000
    const turn = await harness.prompt({ sessionId, prompt: text('Hi.') })
    assert.equal(turn.stopReason, 'end_turn')
    assert.deepEqual(compactionTrail(updates), [])
    assert.equal(endpoint.bodies.filter(isSummaryRequest).length, 0)
  } finally {
    await endpoint.close()
  }
})

test('a turn whose context fills between tool calls compacts mid-turn and carries on from the summary', async () => {
  const endpoint = await startScriptedEndpoint([
    { toolCall: 'probe', usage: { prompt: 990, completion: 10 } },
    { text: 'The user asked for a probe; it ran and answered probed.', usage: { prompt: 860, completion: 14 } },
    { text: 'Done: probed.', usage: { prompt: 40, completion: 4 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.setSessionMode({ sessionId, modeId: 'bypass' })
    const turn = await harness.prompt({ sessionId, prompt: text('Run the probe.') })
    assert.equal(turn.stopReason, 'end_turn')

    assert.ok(isSummaryRequest(endpoint.bodies[1]), 'the summary was written between the two steps')
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    const step = endpoint.bodies[2].messages
    assert.equal(step.length, 1, 'the next step is sent the summary alone')
    assert.match(String(step[0].content), /<summary>[\s\S]*Continue the work in progress/)
    const stored = sessions.get(sessionId)?.messages ?? []
    assert.equal(stored[0].role, 'user')
    assert.match(String(stored[0].content), /<summary>/)
    assert.doesNotMatch(String(stored[0].content), /Continue the work/, 'the instruction is for this turn only')
    assert.equal(stored.length, 2, 'the session keeps the summary and the reply after it')
  } finally {
    await endpoint.close()
  }
})

for (const end of ['stopped', 'failing'] as const) {
  test(`a turn ${end} after a mid-turn compaction stores the summary without the instruction to carry on`, async () => {
    const endpoint = await startScriptedEndpoint([
      { toolCall: 'probe', usage: { prompt: 990, completion: 10 } },
      { text: 'The user asked for a probe; it ran and answered probed.', usage: { prompt: 860, completion: 14 } },
      end === 'stopped' ? { hang: true } : { status: 400 },
      { text: 'Hello.', usage: { prompt: 40, completion: 2 } },
    ])
    const sessions = new Map<string, NativeSession>()
    const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
    try {
      const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
      await harness.setSessionMode({ sessionId, modeId: 'bypass' })
      const turn = harness.prompt({ sessionId, prompt: text('Run the probe.') })
      if (end === 'stopped') {
        await endpoint.hanging
        await harness.cancel({ sessionId })
        assert.equal((await turn).stopReason, 'cancelled')
      } else {
        // How a turn reports an endpoint error is the harness's general
        // behaviour, not this test's subject; what it stores is.
        await turn.catch(() => undefined)
      }
      assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
      assert.match(String(endpoint.bodies[2].messages[0].content), /Continue the work/, 'precondition')

      const stored = sessions.get(sessionId)?.messages ?? []
      assert.equal(stored.length, 1, 'the summary alone: the work after it was not finished')
      assert.match(String(stored[0].content), /answered probed/)
      assert.doesNotMatch(String(stored[0].content), /Continue the work/)
      const after = keptEstimate(endpoint.bodies[0], 990, 'Run the probe.') + 14
      assert.equal(sessions.get(sessionId)?.contextUsed, after, "the compaction's reading stands, not the step's before it")
      assert.equal(lastUsage(updates), after)

      await harness.prompt({ sessionId, prompt: text('Hello?') })
      const next = endpoint.bodies[3].messages
      assert.equal(next.length, 2, 'the next turn is sent the summary, then its own message')
      assert.doesNotMatch(String(next[0].content), /Continue the work/)
      assert.equal(next[1].content, 'Hello?')
    } finally {
      await endpoint.close()
    }
  })
}

test('a turn stopped after compacting at its start keeps the summary and its prompt', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted.', usage: { prompt: 995, completion: 5 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 870, completion: 10 } },
    { hang: true },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    const turn = harness.prompt({ sessionId, prompt: text('What is the codeword?') })
    await endpoint.hanging
    await harness.cancel({ sessionId })
    assert.equal((await turn).stopReason, 'cancelled')

    const stored = sessions.get(sessionId)?.messages ?? []
    assert.equal(stored.length, 2)
    assert.match(String(stored[0].content), /codeword heron/)
    assert.doesNotMatch(String(stored[0].content), /Continue the work/)
    assert.deepEqual(stored[1], { role: 'user', content: 'What is the codeword?' })
  } finally {
    await endpoint.close()
  }
})

test('a turn stopped during its automatic compaction reports it cancelled and keeps the conversation it had', async () => {
  const endpoint = await startScriptedEndpoint([
    { toolCall: 'probe', usage: { prompt: 990, completion: 10 } },
    { hang: true },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.setSessionMode({ sessionId, modeId: 'bypass' })
    const turn = harness.prompt({ sessionId, prompt: text('Run the probe.') })
    await endpoint.hanging
    await harness.cancel({ sessionId })
    assert.equal((await turn).stopReason, 'cancelled')
    assert.deepEqual(
      compactionTrail(updates).filter((step) => step !== 'chunk'),
      ['in_progress', 'cancelled'],
    )
    assert.deepEqual(
      sessions.get(sessionId)?.messages,
      [{ role: 'user', content: 'Run the probe.' }],
      'as any stopped turn: its prompt stays, its unfinished reply does not',
    )
    assert.equal(sessions.get(sessionId)?.abort, undefined)
  } finally {
    await endpoint.close()
  }
})

test('a new session advertises /compact through the client, where the composer reads commands', async () => {
  const endpoint = await startScriptedEndpoint([])
  const cwd = await mkdtemp(join(tmpdir(), 'native-commands-'))
  const client = createAgentClient({})
  try {
    const meta = await client.createSession({
      providerId: 'openai-compatible',
      adapterId: 'native',
      model: 'test-model',
      apiKey: 'test-key',
      cwd,
      baseUrl: endpoint.baseUrl,
    })
    const events: ChatEvent[] = []
    const unsubscribe = client.subscribe(meta.id, (event) => events.push(event))
    await new Promise((resolve) => setTimeout(resolve, 20))
    unsubscribe()
    const advertised = events.find((event) => event.kind === 'available_commands')
    assert.ok(advertised && advertised.kind === 'available_commands', 'the list reached the session')
    assert.deepEqual(
      advertised.commands.map((command) => command.name),
      ['compact'],
    )
    await client.deleteSession(meta.id)
  } finally {
    await endpoint.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a failed automatic compaction is reported, tried once, and the turn goes on with the context it had', async () => {
  const endpoint = await startScriptedEndpoint([
    { toolCall: 'probe', usage: { prompt: 990, completion: 10 } },
    { status: 400 },
    { toolCall: 'probe', usage: { prompt: 850, completion: 10 } },
    { text: 'Done.', usage: { prompt: 880, completion: 2 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.setSessionMode({ sessionId, modeId: 'bypass' })
    const turn = await harness.prompt({ sessionId, prompt: text('Run the probe twice.') })
    assert.equal(turn.stopReason, 'end_turn')
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'failed'])
    assert.equal(endpoint.bodies.filter(isSummaryRequest).length, 1, 'not retried on the next step')
    assert.equal(endpoint.bodies[2].messages.length, 3, 'the next step is sent the whole conversation')
    assert.equal(sessions.get(sessionId)?.messages.length, 6)
  } finally {
    await endpoint.close()
  }
})

// A system prompt long enough to be most of a session's first call, as a
// real agent's instructions and tool declarations are.
const LONG_SYSTEM_PROMPT = 'Answer carefully and keep to the task. '.repeat(300)

test("/compact reports the kept part, at the first call's measure, plus the summary, whatever the conversation held", async () => {
  const reasoning = 'I weigh which bird to name first. '.repeat(300)
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted: the codeword is heron.', usage: { prompt: 3_000, completion: 10 } },
    { text: 'Forty birds.', reasoning, usage: { prompt: 3_100, completion: 30_000, reasoning: 2_400 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 9_000, completion: 350, reasoning: 300 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, 60_000, LONG_SYSTEM_PROMPT)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember the codeword heron.') })
    await harness.prompt({ sessionId, prompt: text('Write forty birds.') })
    await harness.prompt({ sessionId, prompt: text('/compact') })
    const facts = (
      updates.filter((u) => u.sessionUpdate === 'compaction_update').at(-1)?._meta as {
        contextCompaction: Record<string, unknown>
      }
    ).contextCompaction
    assert.equal(facts.preTokens, 33_100)

    const kept = keptEstimate(endpoint.bodies[0], 3_000, 'Remember the codeword heron.')
    assert.ok(kept > 2_950, 'precondition: the first call is almost all fixed part')
    assert.equal(facts.postTokens, kept + 50, "the kept part and the summary's text, not the reasoning that wrote it")
    assert.equal(lastUsage(updates), kept + 50)
  } finally {
    await endpoint.close()
  }
})

test('a session whose first call measured nothing takes its measure from the next call that does', async () => {
  const endpoint = await startScriptedEndpoint([
    { status: 400 },
    { text: 'Noted.', usage: { prompt: 3_000, completion: 5 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 300, completion: 12 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, 60_000, LONG_SYSTEM_PROMPT)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Hello.') }).catch(() => undefined)
    await harness.prompt({ sessionId, prompt: text('Remember the codeword heron.') })
    assert.deepEqual(
      endpoint.bodies[1].messages.filter((m) => m.role === 'user').map((m) => m.content),
      ['Hello.', 'Remember the codeword heron.'],
      'precondition: the second call was sent both prompts',
    )
    await harness.prompt({ sessionId, prompt: text('/compact') })
    const kept = keptEstimate(endpoint.bodies[1], 3_000, 'Hello.Remember the codeword heron.')
    assert.equal(lastUsage(updates), kept + 12)
  } finally {
    await endpoint.close()
  }
})

test('a configured window does not compact one token short of full, and compacts once full', async () => {
  const endpoint = await startScriptedEndpoint(
    [
      { text: 'Noted.', usage: { prompt: 990, completion: 9 } },
      { text: 'Noted again.', usage: { prompt: 995, completion: 5 } },
      { text: 'The user set the codeword heron.', usage: { prompt: 900, completion: 10 } },
      { text: 'heron', usage: { prompt: 50, completion: 2 } },
    ],
    // The endpoint's own window is larger: the configured one decides.
    4000,
  )
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, 1000)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    assert.equal(lastUsage(updates), 999, 'precondition: one token short of the window')

    await harness.prompt({ sessionId, prompt: text('And keep it.') })
    assert.deepEqual(compactionTrail(updates), [], 'no compaction below the configured window')
    assert.equal(lastUsage(updates), 1000, 'precondition: the window is full')

    await harness.prompt({ sessionId, prompt: text('What is the codeword?') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    assert.ok(isSummaryRequest(endpoint.bodies[2]), 'the third turn compacted before its model call')
    const facts = (
      updates.filter((u) => u.sessionUpdate === 'compaction_update').at(-1)?._meta as {
        contextCompaction: Record<string, unknown>
      }
    ).contextCompaction
    assert.equal(facts.trigger, 'automatic')
    assert.equal(facts.preTokens, 1000)
  } finally {
    await endpoint.close()
  }
})

test("a reported window compacts at the ratio, the margin its summary needs", async () => {
  const endpoint = await startScriptedEndpoint(
    [
      { text: 'Noted.', usage: { prompt: 795, completion: 4 } },
      { text: 'Noted again.', usage: { prompt: 796, completion: 4 } },
      { text: 'The user set the codeword heron.', usage: { prompt: 800, completion: 10 } },
      { text: 'heron', usage: { prompt: 50, completion: 2 } },
    ],
    1000,
  )
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, null)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron.') })
    await harness.prompt({ sessionId, prompt: text('And keep it.') })
    assert.deepEqual(compactionTrail(updates), [], 'no compaction at 799 of 1000')
    assert.equal(lastUsage(updates), 800, 'precondition: 80% of the reported window')

    await harness.prompt({ sessionId, prompt: text('What is the codeword?') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    assert.ok(isSummaryRequest(endpoint.bodies[2]))
  } finally {
    await endpoint.close()
  }
})

test('an automatic compaction that leaves the configured window full is not repeated on the next turns', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'OK', usage: { prompt: 18_900, completion: 100 } },
    { text: 'The user set the codeword heron.', usage: { prompt: 400, completion: 300 } },
    { text: 'Twelve birds of prey.', usage: { prompt: 19_300, completion: 669 } },
    { text: 'Noted.', usage: { prompt: 19_500, completion: 77 } },
    { text: 'Noted again.', usage: { prompt: 19_600, completion: 80 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, 19_000, LONG_SYSTEM_PROMPT)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const first = 'Remember heron. Reply with just OK.'
    await harness.prompt({ sessionId, prompt: text(first) })
    assert.equal(lastUsage(updates), 19_000, 'precondition: the window is full')

    await harness.prompt({ sessionId, prompt: text('List 12 birds of prey.') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    const after = keptEstimate(endpoint.bodies[0], 18_900, first) + 300
    assert.ok(after >= 19_000, `precondition: the compaction left the window full (${after})`)

    await harness.prompt({ sessionId, prompt: text('Context restored.') })
    await harness.prompt({ sessionId, prompt: text('Context restored.') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'], 'one compaction, not one a turn')
    assert.equal(endpoint.bodies.filter(isSummaryRequest).length, 1)
  } finally {
    await endpoint.close()
  }
})

test('a compaction estimated to leave the window full, whose next call measures room, lets the session compact again once full', async () => {
  const endpoint = await startScriptedEndpoint([
    // Screenshots bill far more tokens than the characters that stand for
    // them, so this first call's measure counts the fixed part high.
    { text: 'Noted.', usage: { prompt: 11_000, completion: 1_000 } },
    { text: 'The user shared four screenshots.', usage: { prompt: 11_500, completion: 1_200 } },
    { text: 'They show a login form.', usage: { prompt: 6_500, completion: 100 } },
    { text: 'Done.', usage: { prompt: 11_000, completion: 1_000 } },
    { text: 'The user is reviewing a login form.', usage: { prompt: 11_500, completion: 300 } },
    { text: 'heron', usage: { prompt: 5_400, completion: 2 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, 12_000, LONG_SYSTEM_PROMPT)
  const screenshot = { type: 'image' as const, data: 'aGVyb24=', mimeType: 'image/png' }
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Look at these.' }, screenshot, screenshot, screenshot, screenshot],
    })
    assert.equal(lastUsage(updates), 12_000, 'precondition: the window is full')

    await harness.prompt({ sessionId, prompt: text('What do they show?') })
    const facts = (
      updates.filter((u) => u.sessionUpdate === 'compaction_update').at(-1)?._meta as {
        contextCompaction: Record<string, unknown>
      }
    ).contextCompaction
    assert.ok(Number(facts.postTokens) >= 12_000, `precondition: estimated to leave no room (${facts.postTokens})`)
    assert.equal(lastUsage(updates), 6_600, 'precondition: the next call measured room')

    await harness.prompt({ sessionId, prompt: text('Fill the form in.') })
    assert.equal(lastUsage(updates), 12_000, 'precondition: the window is full again')

    await harness.prompt({ sessionId, prompt: text('What is the codeword?') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed', 'in_progress', 'chunk', 'completed'])
    assert.ok(isSummaryRequest(endpoint.bodies[4]), 'the fourth turn compacted before its model call')
  } finally {
    await endpoint.close()
  }
})

test('a compaction estimated to leave the window full, whose next call measures room, compacts again in the same turn once full', async () => {
  const endpoint = await startScriptedEndpoint([
    { text: 'Noted.', usage: { prompt: 11_000, completion: 1_000 } },
    { text: 'The user shared four screenshots.', usage: { prompt: 11_500, completion: 1_200 } },
    { toolCall: 'probe', usage: { prompt: 6_500, completion: 10 } },
    { toolCall: 'probe', usage: { prompt: 11_990, completion: 10 } },
    { text: 'The user asked for two probes; both answered probed.', usage: { prompt: 11_500, completion: 300 } },
    { text: 'Done: probed.', usage: { prompt: 5_400, completion: 4 } },
  ])
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, 12_000, LONG_SYSTEM_PROMPT)
  const screenshot = { type: 'image' as const, data: 'aGVyb24=', mimeType: 'image/png' }
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.setSessionMode({ sessionId, modeId: 'bypass' })
    await harness.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Look at these.' }, screenshot, screenshot, screenshot, screenshot],
    })
    assert.equal(lastUsage(updates), 12_000, 'precondition: the window is full')

    await harness.prompt({ sessionId, prompt: text('Run the probe twice.') })
    const first = (
      updates.find((u) => u.sessionUpdate === 'compaction_update' && u.status === 'completed')?._meta as {
        contextCompaction: Record<string, unknown>
      }
    ).contextCompaction
    assert.ok(Number(first.postTokens) >= 12_000, `precondition: estimated to leave no room (${first.postTokens})`)
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed', 'in_progress', 'chunk', 'completed'])
    assert.ok(isSummaryRequest(endpoint.bodies[4]), 'the second compaction came between the two probes and the reply')
  } finally {
    await endpoint.close()
  }
})

test('an automatic compaction that cannot bring the context under the ratio is not repeated on the next turns', async () => {
  const endpoint = await startScriptedEndpoint(
    [
      { text: 'OK', usage: { prompt: 15_100, completion: 100 } },
      { text: 'The user set the codeword heron.', usage: { prompt: 400, completion: 100 } },
      { text: 'Twelve birds of prey.', usage: { prompt: 15_300, completion: 669 } },
      { text: 'Noted.', usage: { prompt: 15_500, completion: 77 } },
      { text: 'Noted again.', usage: { prompt: 15_600, completion: 80 } },
    ],
    19_000,
  )
  const sessions = new Map<string, NativeSession>()
  const { harness, updates } = harnessFor(endpoint.baseUrl, sessions, null, LONG_SYSTEM_PROMPT)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.prompt({ sessionId, prompt: text('Remember heron. Reply with just OK.') })
    assert.equal(lastUsage(updates), 15_200, 'precondition: 80% of the reported window')

    await harness.prompt({ sessionId, prompt: text('List 12 birds of prey.') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'])
    assert.equal(lastUsage(updates), 15_969, 'still past the ratio after the compaction')

    // Turns that add little, as the host's restore note does.
    await harness.prompt({ sessionId, prompt: text('Context restored.') })
    await harness.prompt({ sessionId, prompt: text('Context restored.') })
    assert.deepEqual(compactionTrail(updates), ['in_progress', 'chunk', 'completed'], 'one compaction, not one a turn')
    assert.equal(endpoint.bodies.filter(isSummaryRequest).length, 1)
  } finally {
    await endpoint.close()
  }
})
