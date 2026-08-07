import { createFileRoute } from '@tanstack/react-router'

import { recordCaller, refuses, resolveCaller } from '@/app/_authed/(mcp)/_server/caller'
import { getExtensionToolDefinitions } from '@/app/_authed/(mcp)/_server/extension-tools'
import { mcpAuthMode } from '@/app/_authed/(mcp)/_server/mcp-auth-mode'
import { getAgentToolDefinitions, handleToolCall, toolDefinitions } from '@/app/_authed/(mcp)/_server/tools'

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

async function handleMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { signal?: AbortSignal; internal?: boolean; callerAgent?: string | null },
) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'opencroft-mcp', version: '0.3.0' },
      }

    case 'notifications/initialized':
      return null

    case 'tools/list': {
      const staticNames = new Set(toolDefinitions.map((t) => t.name))
      const extensionTools = await getExtensionToolDefinitions(staticNames)
      const agentTools = await getAgentToolDefinitions(new Set(extensionTools.map((t) => t.name)))
      return {
        tools: [
          ...toolDefinitions,
          ...extensionTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          ...agentTools,
        ],
      }
    }

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

export const Route = createFileRoute('/_authed/(mcp)/api/mcp')({
  server: {
    handlers: {
      // Streamable HTTP: POST — handle JSON-RPC requests
      POST: async ({ request }) => {
        const body = (await request.json()) as MCPRequest

        if (body.jsonrpc !== '2.0') {
          return Response.json(mcpErr(body.id ?? null, -32600, 'Invalid Request'), { status: 400 })
        }

        // Resolve whatever credential the caller presented and record that we
        // saw them, in every mode including `require` — Stage B still needs
        // the caller population recorded, refused requests included, or a
        // spike in refusals after a rollout would be invisible everywhere
        // except the client's own error, which is exactly the situation this
        // observability exists to avoid.
        //
        // The awaits are deliberate. A fire-and-forget write is one the
        // process can lose on exit, which would undercount exactly the rare
        // caller this exists to find, and undercounting reads as "all
        // accounted for". resolveCaller only runs when an Authorization
        // header is present; recordCaller swallows its own errors.
        const caller = await resolveCaller(request)
        await recordCaller({
          caller,
          method: body.method,
          tool: body.method === 'tools/call' ? ((body.params?.name as string | undefined) ?? null) : null,
          request,
        })

        // Stage B. `observe` and `off` never reach this: `refuses`
        // is false for both, by construction (see caller.ts). Only `require`
        // can end the request here, and only for a caller that did not
        // resolve to a credential we issued — present-and-valid callers are
        // unaffected in every mode.
        if (refuses(mcpAuthMode(), caller)) {
          const message =
            caller.credential === 'absent'
              ? 'Missing credential — send Authorization: Bearer <token>.'
              : 'Credential not recognised — it may be mistyped, revoked, or expired.'
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
            // The agent behind the credential, when one resolved. This is the
            // ONLY entry point that can know it — the in-process bridge has no
            // credential to present — and it is passed as data rather than
            // re-resolved downstream so there is exactly one place the identity
            // is decided. A tool that acts on behalf of an agent refuses when
            // this is null; see ToolCallerContext.
            callerAgent: caller.agent,
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
