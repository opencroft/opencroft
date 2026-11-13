import { createFileRoute } from '@tanstack/react-router'
import { MCP_FORWARDED_HEADER } from 'agent-client'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'

// The engine's MCP server for a harness that runs through a terminal, on
// another machine or in a container this server's loopback does not reach
// (agent-terminal.ts gives the harness this address). Every request is relayed
// to the engine's own server, marked as relayed, so the engine holds it to the
// rule for a caller from outside: it is served only on the session token the
// engine gave that harness (`x-agent-session`), and refused otherwise.
//
// Not session-gated, despite sitting under `_authed`: a server handler answers
// before the router runs the layout's page gate. The session token is the
// gate, checked by the engine on every request.

const SESSION_HEADER = 'x-agent-session'

// Headers that describe one hop, not the message; fetch sets its own.
const HOP_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']

async function relay(request: Request): Promise<Response> {
  if (!request.headers.get(SESSION_HEADER)) {
    return Response.json({ error: `Missing ${SESSION_HEADER}` }, { status: 401 })
  }
  const headers = new Headers(request.headers)
  for (const name of HOP_HEADERS) {
    headers.delete(name)
  }
  headers.set(MCP_FORWARDED_HEADER, '1')
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const answer = await fetch(await agentClient.mcpServerUrl(), {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  })
  // fetch hands over the body decoded, which its encoding and length headers
  // do not describe.
  const out = new Headers(answer.headers)
  for (const name of ['content-encoding', 'content-length', ...HOP_HEADERS]) {
    out.delete(name)
  }
  return new Response(answer.body, { status: answer.status, headers: out })
}

export const Route = createFileRoute('/_authed/(agent)/agent-mcp')({
  server: {
    handlers: {
      POST: ({ request }) => relay(request),
      GET: ({ request }) => relay(request),
      DELETE: ({ request }) => relay(request),
    },
  },
})
