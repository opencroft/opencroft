import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildConfigOptions,
  CANCELLED,
  createNativeHarness,
  NATIVE_PROMPT_CAPABILITIES,
  type NativeSession,
  raceAbort,
  toModelContent,
  toolPermissionDecision,
} from './native-harness'
import type { AgentSelection } from './types'

// raceAbort backs the permission gate a tool call waits on: without it, a
// promise that eventually resolves after its turn was cancelled would still
// let the caller proceed as if nothing had happened.
test('resolves to the promise value when it settles before the signal aborts', async () => {
  const controller = new AbortController()
  const result = await raceAbort(Promise.resolve('allowed'), controller.signal)
  assert.equal(result, 'allowed')
})

test('resolves to CANCELLED when the signal aborts before the promise settles, and ignores the late settlement', async () => {
  const controller = new AbortController()
  let settleLate: (value: string) => void = () => {}
  const late = new Promise<string>((resolve) => {
    settleLate = resolve
  })

  const raced = raceAbort(late, controller.signal)
  controller.abort()
  assert.equal(await raced, CANCELLED)

  // The late resolution must not throw or otherwise surface once nothing is
  // listening for it — this simulates a permission response arriving after
  // the turn that asked for it has already moved on.
  settleLate('allowed-too-late')
})

test('an already-aborted signal short-circuits without waiting on the promise at all', async () => {
  const controller = new AbortController()
  controller.abort()
  const neverSettles = new Promise<string>(() => {})
  const result = await raceAbort(neverSettles, controller.signal)
  assert.equal(result, CANCELLED)
})

test('a rejection before abort propagates as a rejection, not as CANCELLED', async () => {
  const controller = new AbortController()
  await assert.rejects(raceAbort(Promise.reject(new Error('boom')), controller.signal), /boom/)
})

test('with no signal at all, the promise is returned untouched', async () => {
  const result = await raceAbort(Promise.resolve('value'), undefined)
  assert.equal(result, 'value')
})

// The session's permission mode, resolved against the grant a session's roles
// already produced for one tool. Stated as a table because the interesting part
// is the whole matrix, not any single cell.

test('a mode that skips the prompt allows the call outright', () => {
  assert.equal(toolPermissionDecision('bypass', 'Allow'), 'allow')
  assert.equal(toolPermissionDecision('accept-edits', 'Allow'), 'allow')
})

test('the reject mode declines without asking', () => {
  assert.equal(toolPermissionDecision('reject-edits', 'Allow'), 'deny')
})

test('the manual mode asks', () => {
  assert.equal(toolPermissionDecision('manual-edits', 'Allow'), 'ask')
})

test('an AlwaysAllow grant outranks every mode except an explicit refusal', () => {
  assert.equal(toolPermissionDecision('manual-edits', 'AlwaysAllow'), 'allow')
  // Even reject: the grant is a per-tool decision the host made deliberately,
  // and the mode is only the default it sits inside.
  assert.equal(toolPermissionDecision('reject-edits', 'AlwaysAllow'), 'allow')
})

test('an unknown mode asks rather than assuming permission', () => {
  // 'default' is what sessions created before these modes existed still carry;
  // plan and auto are advertised only by ACP agents.
  for (const mode of ['default', 'plan', 'auto', '']) {
    assert.equal(toolPermissionDecision(mode, 'Allow'), 'ask', mode)
  }
})

// What the harness advertises over the config-option surface. The client picks
// these out by id and gives each its own control, so both the ids and the
// decision to omit an option entirely are part of the contract.

// Only the fields buildConfigOptions reads. Cast rather than filled out: the
// full selection carries a dozen transport fields none of this touches.
const selectionFor = (model: string, providerId = 'openai', reasoningEffort?: string) =>
  ({ model, providerId, reasoningEffort }) as unknown as Parameters<typeof buildConfigOptions>[1]

const sessionFor = (over: Partial<Parameters<typeof buildConfigOptions>[0]> = {}) =>
  ({ messages: [], mode: 'manual-edits', ...over }) as Parameters<typeof buildConfigOptions>[0]

const byId = (options: ReturnType<typeof buildConfigOptions>, id: string) =>
  options.find((option) => option.id === id) as { currentValue?: unknown; options?: { value: string }[] } | undefined

test('the permission mode is always advertised, at the id the composer reads', () => {
  const mode = byId(buildConfigOptions(sessionFor(), selectionFor('gpt-5')), 'mode')
  assert.ok(mode)
  assert.equal(mode.currentValue, 'manual-edits')
  assert.deepEqual(
    mode.options?.map((o) => o.value),
    ['manual-edits', 'accept-edits', 'reject-edits', 'bypass'],
  )
})

test('a prompt of words alone stays a plain string', () => {
  // The parts form exists for the mixed case. Paying for it always would change
  // what every stored message looks like, for every turn that attaches nothing.
  assert.equal(toModelContent([{ type: 'text', text: 'hello' }]), 'hello')
})

test('an image block becomes an image part carrying its media type', () => {
  // mediaType is what tells an OpenAI-compatible endpoint to route the turn to
  // a vision model rather than reject a wall of base64.
  assert.deepEqual(
    toModelContent([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]),
    [
      { type: 'text', text: 'look' },
      { type: 'image', image: 'AAAA', mediaType: 'image/png' },
    ],
  )
})

test('this harness claims images and nothing it cannot convert', () => {
  // The engine reads this same constant to decide whether an attachment may
  // travel — a native selection is never handshaken, so there is no initialize
  // answer to read instead. Claiming audio or embedded context here would
  // invite a block the conversion above would drop on the floor.
  assert.deepEqual(NATIVE_PROMPT_CAPABILITIES, { image: true })
})

test('every option names the ACP category for its meaning, not only its id', () => {
  // The id is what the composer keys on; `category` is what the protocol marks
  // the meaning with, and what the engine reads to find the model a session is
  // running. With the categories missing, a Custom session kept reporting its
  // profile's model after a live switch — the option held the new one and
  // nothing looked at it.
  const options = buildConfigOptions(sessionFor(), selectionFor('gpt-5'))
  assert.deepEqual(
    options.map((option) => [option.id, option.category]),
    [
      ['mode', 'mode'],
      ['model', 'model'],
      ['effort', 'thought_level'],
    ],
  )
})

test('a model with no known reasoning levels advertises no effort option at all', () => {
  // An empty dropdown is worse than no control: it invites a choice that does
  // not exist.
  assert.equal(byId(buildConfigOptions(sessionFor(), selectionFor('some-plain-model')), 'effort'), undefined)
})

test('a reasoning model offers the grades it takes, then off as the floor', () => {
  // `off` asks to think as little as the endpoint allows: the weakest grade
  // the scale has, or nothing for a model that only thinks when asked. The
  // client adds 'default' itself.
  const effort = byId(buildConfigOptions(sessionFor(), selectionFor('gpt-5')), 'effort')
  assert.ok(effort)
  assert.deepEqual(
    effort.options?.map((o) => o.value),
    ['minimal', 'low', 'medium', 'high', 'off'],
  )
})

test('a session choice outranks the profile for both model and effort', () => {
  const options = buildConfigOptions(
    sessionFor({ model: 'gpt-5', effort: 'high' }),
    selectionFor('gpt-4o', 'openai', 'low'),
  )
  assert.equal(byId(options, 'model')?.currentValue, 'gpt-5')
  assert.equal(byId(options, 'effort')?.currentValue, 'high')
})

test('a model the provider list does not name still appears, or it could not be returned to', () => {
  const model = byId(buildConfigOptions(sessionFor(), selectionFor('custom-deployment')), 'model')
  assert.ok(model?.options?.some((o) => o.value === 'custom-deployment'))
})

test('what the endpoint reports outranks the provider table', () => {
  // The table lists gpt-5/gpt-5-codex for this provider; the endpoint is the
  // one that knows what it actually serves.
  const model = byId(
    buildConfigOptions(sessionFor(), selectionFor('gpt-5'), [{ id: 'gpt-5' }, { id: 'local-mixtral' }]),
    'model',
  )
  assert.deepEqual(
    model?.options?.map((o) => o.value),
    ['gpt-5', 'local-mixtral'],
  )
})

test('an endpoint that reports nothing falls back to the provider table', () => {
  const model = byId(buildConfigOptions(sessionFor(), selectionFor('gpt-5'), []), 'model')
  assert.ok((model?.options?.length ?? 0) > 1)
})

// ---------------------------------------------------------------------------
// A CANCELLED TURN RELEASES THE SESSION.
//
// `session.abort` is the in-flight marker AND the guard a later prompt is
// refused by. If a turn ends without clearing it, the session answers "A turn
// is already in progress." forever -- no error, no busy indicator, and a reload
// does not help, because the state is in this process rather than on the row.
//
// These run against a REAL streaming endpoint on localhost rather than a stubbed
// model, deliberately. The bug is about what the AI SDK does to a turn when its
// signal aborts -- whether the stream throws or simply ends -- and a stub would
// encode the assumption under test instead of exercising it.
// ---------------------------------------------------------------------------

interface FakeEndpoint {
  baseUrl: string
  /** Resolves once a request has been answered with its first streamed chunk. */
  streaming: Promise<void>
  requests: () => number
  /**
   * Destroy the open response mid-body, as a model server dying under a turn
   * does. Separate from `close` so a test can choose the moment — the turn has
   * to be observably in flight first, or the assertion afterwards cannot mean
   * what it says.
   */
  kill: () => void
  close: () => Promise<void>
}

/**
 * An OpenAI-compatible endpoint that starts streaming and then STOPS, without
 * ever sending `[DONE]`.
 *
 * The open connection is the point: it holds the turn in flight so the test can
 * cancel a turn that is genuinely running, rather than racing one that has
 * already finished. `completeAfter` requests are answered in full instead, which
 * is how the second turn in the test below gets to finish normally.
 */
async function startHangingEndpoint(completeAfter = 1): Promise<FakeEndpoint> {
  const { createServer } = await import('node:http')
  let served = 0
  let announceStreaming: () => void = () => {}
  const streaming = new Promise<void>((resolve) => {
    announceStreaming = resolve
  })
  const open = new Set<import('node:http').ServerResponse>()

  const server = createServer((req, res) => {
    // Drained rather than read: nothing here depends on what was asked, only on
    // answering it -- but the body still has to be consumed for 'end' to fire.
    req.resume()
    req.on('end', () => {
      served += 1
      const index = served
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      open.add(res)
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: `chunk-${index}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(chunk({ role: 'assistant', content: 'tick' }, null))
      if (index <= completeAfter) {
        // Answer and then hold the connection open: the turn stays in flight
        // until something aborts it.
        announceStreaming()
        return
      }
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      open.delete(res)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the fake endpoint did not bind a port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    streaming,
    requests: () => served,
    kill: () => {
      for (const res of open) {
        res.destroy()
        open.delete(res)
      }
    },
    close: async () => {
      for (const res of open) {
        res.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function harnessFor(endpoint: FakeEndpoint, sessions: Map<string, NativeSession>) {
  const chunks: string[] = []
  const client = {
    sessionUpdate: async (params: { update: { content?: { text?: string } } }) => {
      const text = params.update.content?.text
      if (typeof text === 'string') {
        chunks.push(text)
      }
    },
  } as unknown as Parameters<typeof createNativeHarness>[0]
  const selection: AgentSelection = {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: process.cwd(),
    baseUrl: endpoint.baseUrl,
  }
  const harness = createNativeHarness(client, selection, { tools: [], skills: [] }, sessions)
  return { harness, chunks }
}

test('a turn cancelled mid-stream releases the session, so the next prompt is accepted', async () => {
  const endpoint = await startHangingEndpoint()
  const sessions = new Map<string, NativeSession>()
  const { harness, chunks } = harnessFor(endpoint, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })

    // Not awaited: the endpoint holds this turn open on purpose.
    const first = harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'count to three hundred' }] })
    await endpoint.streaming
    assert.ok(sessions.get(sessionId)?.abort, 'precondition: the turn really is in flight')

    await harness.cancel({ sessionId })
    await first

    // THE STRUCTURAL ASSERTION. The marker is the guard, so a marker left set
    // is the wedge, whatever the stop reason says.
    assert.equal(sessions.get(sessionId)?.abort, undefined, 'the cancelled turn released the in-flight marker')

    // THE BEHAVIOURAL ONE, which is what the reporter saw: every later message
    // answered "A turn is already in progress." and nothing else, forever.
    chunks.length = 0
    await harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'say only: omega' }] })
    assert.ok(
      !chunks.some((c) => c.includes('A turn is already in progress')),
      `the next prompt was refused as if a turn were still running: ${JSON.stringify(chunks)}`,
    )
    assert.ok(endpoint.requests() >= 2, 'and it actually reached the endpoint rather than being refused before it')
  } finally {
    await endpoint.close()
  }
})

test('an endpoint that dies mid-stream also releases the session', async () => {
  // The other way a turn ends badly, and the one nobody chooses: llama-cpp
  // restarting under a running turn. Here the stream really does throw, rather
  // than stopping the way an abort makes it stop -- so this reaches the exit the
  // cancel tests do not, and the marker has to be released from there too.
  const endpoint = await startHangingEndpoint()
  const sessions = new Map<string, NativeSession>()
  const { harness } = harnessFor(endpoint, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const turn = harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await endpoint.streaming

    // THE PRECONDITION, and without it "undefined" below is not evidence.
    // A session that was never created, or a marker that was never set, would
    // read as released just as loudly as one that was released. Asserting the
    // marker IS set here is what makes the later assertion mean "released".
    assert.ok(sessions.get(sessionId)?.abort, 'precondition: the turn is in flight with its marker set')

    endpoint.kill()
    // However it ends -- thrown or returned -- the invariant is the same one.
    await turn.catch(() => {})

    assert.ok(sessions.has(sessionId), 'the session itself survives; only the turn ended')
    assert.equal(sessions.get(sessionId)?.abort, undefined, 'a turn killed by its endpoint released the marker too')
  } finally {
    await endpoint.close()
  }
})

test('a second prompt arriving while a turn really is running is still refused', async () => {
  // The control for the test above. Releasing the marker on cancel must not be
  // done by removing the guard -- so the guard is checked here, in the one state
  // it exists for. Without this, deleting the refusal outright would pass.
  const endpoint = await startHangingEndpoint()
  const sessions = new Map<string, NativeSession>()
  const { harness, chunks } = harnessFor(endpoint, sessions)
  try {
    const { sessionId } = await harness.newSession({ cwd: process.cwd(), mcpServers: [] })
    const first = harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'count to three hundred' }] })
    await endpoint.streaming

    chunks.length = 0
    const refused = await harness.prompt({ sessionId, prompt: [{ type: 'text', text: 'interrupting' }] })
    assert.equal(refused.stopReason, 'refusal')
    assert.ok(
      chunks.some((c) => c.includes('A turn is already in progress')),
      'the caller is told why, rather than getting silence',
    )

    await harness.cancel({ sessionId })
    await first
  } finally {
    await endpoint.close()
  }
})
