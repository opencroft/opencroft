import { createFileRoute } from '@tanstack/react-router'

import { recordCaller, resolveCaller } from '@/app/_authed/(mcp)/_server/caller'
import {
  handleToolCall,
  listDynamicTools,
  type ToolCallOptions,
  toolDefinitions,
} from '@/app/_authed/(mcp)/_server/tools'

type MCPRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

type MCPResponse = {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

function mcpRes(id: number | string | null, result: unknown): MCPResponse {
  return { jsonrpc: '2.0', id, result }
}

function mcpErr(id: number | string | null, code: number, message: string): MCPResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleMethod(method: string, params: Record<string, unknown> | undefined, opts: ToolCallOptions) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'opencroft-mcp', version: '0.3.0' },
      }

    case 'notifications/initialized':
      return null

    case 'tools/list':
      // Both lists already presented: an extension or graph tool marked
      // `awaitable` or `async` reads here exactly as it does to the bridge.
      return { tools: [...toolDefinitions, ...(await listDynamicTools())] }

    case 'tools/call': {
      const name = params?.name as string | undefined
      if (!name) {
        throw { code: -32602, message: 'Missing tool name' }
      }

      const args = (params?.arguments as Record<string, unknown>) ?? {}
      return handleToolCall(name, args, opts)
    }

    default:
      throw { code: -32601, message: `Method not found: ${method}` }
  }
}

function generateSessionId(): string {
  return `opencroft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// The MCP endpoint, for clients outside this process. The app's own agents do
// not come through here — they reach the same tools in-process through the
// tool bridge, with no credential — so everything that arrives here is an
// external client, and it is served only on an MCP token.
//
// Not session-gated, despite sitting under `_authed`: a server handler answers
// before the router runs the layout's page gate. The token is the gate, and it
// is checked below on every request, before any method runs.
export const Route = createFileRoute('/_authed/(mcp)/mcp')({
  server: {
    handlers: {
      // Streamable HTTP: POST — handle JSON-RPC requests
      POST: async ({ request }) => {
        const body = (await request.json()) as MCPRequest

        if (body.jsonrpc !== '2.0') {
          return Response.json(mcpErr(body.id ?? null, -32600, 'Invalid Request'), { status: 400 })
        }

        // Resolve whatever credential the caller presented and record that we
        // saw them — refused requests included, or a client whose token has
        // expired or been deleted would be visible nowhere except its own
        // error.
        //
        // The awaits are deliberate. A fire-and-forget write is one the
        // process can lose on exit, which would undercount exactly the rare
        // caller this exists to find. recordCaller swallows its own errors.
        const caller = await resolveCaller(request)
        await recordCaller({
          caller,
          method: body.method,
          tool: body.method === 'tools/call' ? ((body.params?.name as string | undefined) ?? null) : null,
          request,
        })

        // Only an MCP token that resolves to an existing agent node gets past
        // here, whatever the method — `initialize` and `tools/list` included,
        // since the tool list describes what this instance can do.
        if (caller.credential !== 'present' || !caller.agentNodeId) {
          const message =
            caller.credential === 'absent'
              ? 'Missing credential — send X-API-Key: <MCP token> (or Authorization: Bearer <MCP token>).'
              : 'Credential not recognised — it may be mistyped, deleted, expired, or not an MCP token.'
          return Response.json(mcpErr(body.id ?? null, -32001, message), { status: 401 })
        }

        try {
          // HTTP callers are never internal.
          //
          // `internal` suppresses the tool-approval gate. It used to be carried
          // by an `x-opencroft-internal` header, back when the app's own agents
          // reached their tools by calling this route over HTTP. They do not any
          // more — tools-bridge.ts wires the same registry in-process and passes
          // `internal: true` directly — so nothing legitimate sends that header,
          // and honouring it only let an unauthenticated caller skip approvals
          // by setting a request header.
          const result = await handleMethod(body.method, body.params as Record<string, unknown> | undefined, {
            signal: request.signal,
            internal: false,
            // The agent node the token was issued to, and its name for
            // display. This is the ONLY entry point that can know the node —
            // the in-process bridge has no credential to present — and it is
            // passed as data rather than re-resolved downstream so there is
            // exactly one place the identity is decided; see ToolCallerContext.
            callerAgent: caller.agent,
            callerAgentNodeId: caller.agentNodeId,
          })

          // Notifications have no id and no response body
          if (body.id === null || body.id === undefined) {
            return new Response(null, { status: 202 })
          }

          const sessionId = generateSessionId()
          return Response.json(mcpRes(body.id, result), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': sessionId,
            },
          })
        } catch (e: unknown) {
          const err = e as { code?: number; message?: string }
          const message = err.message ?? 'Internal error'
          // A tool that fails (bad args, validation, runtime error) should surface
          // to the caller as a tool result with isError — not a JSON-RPC transport
          // error. The MCP client wraps transport errors in an opaque
          // "Error POSTing to endpoint: {…}" envelope that hides the real message;
          // an isError result delivers the message as plain text instead.
          if (body.method === 'tools/call' && body.id !== null && body.id !== undefined) {
            return Response.json(mcpRes(body.id, { content: [{ type: 'text', text: message }], isError: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return Response.json(mcpErr(body.id ?? null, err.code ?? -32603, message), {
            status: 500,
          })
        }
      },

      // Streamable HTTP: GET — session info (405 for stateless implementation)
      GET: () => {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not supported' } }),
          {
            status: 405,
            headers: { 'Content-Type': 'application/json', Allow: 'POST, DELETE' },
          },
        )
      },

      // Streamable HTTP: DELETE — terminate session (200 for stateless implementation)
      DELETE: () => {
        return new Response(null, { status: 200 })
      },
    },
  },
})
