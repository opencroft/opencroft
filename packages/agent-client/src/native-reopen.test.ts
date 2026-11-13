import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import { createAgentClient } from './agent-client'
import { type HistoryPort, type LogWrite, type PlacedEntry, SESSION_LOG } from './transcript-log'
import type { AgentSelection, ChatEvent } from './types'

// A Custom (native) harness session whose process is stopped and which is then
// reopened from the host's recording, as a chat does after its Stop process
// action, an idle unload or a restart: the transcript comes back, and the next
// message is sent to the model with the whole conversation before it.

interface SentMessage {
  role: string
  content: unknown
}

// An OpenAI-compatible endpoint answering each request with the next text.
async function startEndpoint(answers: string[]) {
  const { createServer } = await import('node:http')
  const bodies: { messages: SentMessage[] }[] = []
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
      bodies.push(JSON.parse(raw) as { messages: SentMessage[] })
      const text = answers[bodies.length - 1] ?? 'no more answers'
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const [delta, finish] of [
        [{ role: 'assistant', content: text }, null],
        [{}, 'stop'],
      ] as const) {
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

// The host's copy of the session's own log, by position, as a store keeps it.
function hostLog() {
  const entries = new Map<number, ChatEvent>()
  const port: HistoryPort = {
    read: async (_sessionId, log, from, to) =>
      log !== SESSION_LOG
        ? []
        : [...entries]
            .filter(([position]) => position >= from && position < to)
            .sort(([a], [b]) => a - b)
            .map(([position, event]): PlacedEntry => ({ position, event })),
    turnStartBefore: async (_sessionId, _log, position) => {
      let found: number | null = null
      for (const [at, event] of entries) {
        if (event.kind === 'user' && at < position && (found === null || at > found)) {
          found = at
        }
      }
      return found
    },
    end: async () => Math.max(-1, ...entries.keys()) + 1,
  }
  return {
    port,
    record: (write: LogWrite) => {
      if (write.log === SESSION_LOG) {
        entries.set(write.position, write.event)
      }
    },
    events: () => [...entries].sort(([a], [b]) => a - b).map(([, event]) => event),
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const texts = (messages: SentMessage[]) =>
  messages.map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)

test('a native session reopened after its process stopped keeps its dialog and carries it on', { timeout: 15_000 }, async () => {
  const endpoint = await startEndpoint(['Noted: heron.', 'Noted: blue.', 'The codeword is heron and the colour blue.'])
  const host = hostLog()
  const client = createAgentClient({
    compactLog: true,
    onRecord: (_sessionId, write) => host.record(write),
    history: host.port,
  })
  const selection: AgentSelection = {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: process.cwd(),
    baseUrl: endpoint.baseUrl,
    sessionKey: 'native-reopen-key',
  }
  const turnsEnded = () => host.events().filter((event) => event.kind === 'turn_end').length
  try {
    const meta = await client.createSession(selection)
    await client.prompt(meta.id, 'The codeword is heron.', { queue: 'wait', origin: { kind: 'system' } })
    await until(() => turnsEnded() === 1, 'the first turn')
    await client.prompt(meta.id, 'My colour is blue.', { queue: 'wait', origin: { kind: 'system' } })
    await until(() => turnsEnded() === 2, 'the second turn')

    // Stop the process: the engine lets go of the session and its messages.
    await client.deleteSession(meta.id)
    assert.equal(client.chatHistory(meta.id), null, 'precondition: nothing of the session is left in memory')

    // Reopen from a tail of the recording that starts at the second turn, as a
    // host with a long log gives it: the first turn is read through the port.
    const recorded = host.events()
    const tailFrom = recorded.map((event) => event.kind).lastIndexOf('user')
    const reopened = await client.restoreSession(meta.id, selection, recorded.slice(tailFrom), undefined, {
      start: tailFrom,
      turnsBefore: 1,
    })
    assert.ok(reopened, 'a native session reopens from its recording rather than answering null')
    assert.deepEqual(client.chatHistory(meta.id), [
      { role: 'user', text: 'The codeword is heron.' },
      { role: 'assistant', text: 'Noted: heron.' },
      { role: 'user', text: 'My colour is blue.' },
      { role: 'assistant', text: 'Noted: blue.' },
    ])

    await client.prompt(meta.id, 'What are the codeword and my colour?', { queue: 'wait', origin: { kind: 'system' } })
    await until(() => turnsEnded() === 3, 'the turn after the reopen')
    assert.deepEqual(texts(endpoint.bodies[2].messages), [
      'user: The codeword is heron.',
      'assistant: Noted: heron.',
      'user: My colour is blue.',
      'assistant: Noted: blue.',
      'user: What are the codeword and my colour?',
    ])
    await client.deleteSession(meta.id)
  } finally {
    await endpoint.close()
  }
})
