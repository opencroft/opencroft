// Host tools that answer with pictures, and a local endpoint that records what
// the harness sends it, for the tests of how a tool's pictures reach each model
// API (native-harness-tool-images.test.ts, native-harness-apis.test.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { LocalTool } from '../mcp-server'

/** A 1×1 PNG, 70 bytes. */
export const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
/** 139 bytes standing in for a JPEG; nothing decodes it. */
export const BLUE =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z'

// The first tool answers more slowly than the second, so in a step calling
// both its result settles last.
export const PICTURE_TOOLS: LocalTool[] = [
  {
    name: 'view_red',
    description: 'Shows a red picture.',
    inputSchema: {},
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return {
        content: [
          { type: 'text', text: 'red.png, 1×1' },
          { type: 'image', data: RED, mimeType: 'image/png' },
        ],
      }
    },
  },
  {
    name: 'view_blue',
    description: 'Shows a blue picture.',
    inputSchema: {},
    handler: () => ({
      content: [
        { type: 'text', text: 'blue.jpg, 1×1' },
        { type: 'image', data: BLUE, mimeType: 'image/jpeg' },
      ],
    }),
  },
  { name: 'say', description: 'Answers in words.', inputSchema: {}, handler: () => 'just words' },
  {
    name: 'say_envelope',
    description: 'Answers in words, as an envelope.',
    inputSchema: {},
    handler: () => ({
      content: [
        { type: 'text', text: 'first line' },
        { type: 'text', text: 'second line' },
      ],
    }),
  },
]

export interface RecordedRequest {
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

/**
 * A local endpoint on 127.0.0.1. `GET …/models` answers `models`; every POST
 * is recorded and answered by `answer`, given how many POSTs came before it.
 */
export async function startRecordingEndpoint(
  models: unknown[],
  answer: (res: ServerResponse, index: number) => void,
) {
  const { createServer } = await import('node:http')
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models }))
        return
      }
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      answer(res, requests.length - 1)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the fake endpoint did not bind a port')
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
