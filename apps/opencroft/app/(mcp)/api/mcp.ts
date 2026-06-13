import { createFileRoute } from '@tanstack/react-router'

import { getAgentToolDefinitions, handleToolCall, toolDefinitions } from '@/app/(mcp)/_server/tools'

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
  opts: { signal?: AbortSignal; internal?: boolean },
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
      const agentTools = await getAgentToolDefinitions()
      return { tools: [...toolDefinitions, ...agentTools] }
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

export const Route = createFileRoute('/(mcp)/api/mcp')({
  server: {
    handlers: {
      // Streamable HTTP: POST — handle JSON-RPC requests
      POST: async ({ request }) => {
        const body = (await request.json()) as MCPRequest

        if (body.jsonrpc !== '2.0') {
          return Response.json(mcpErr(body.id ?? null, -32600, 'Invalid Request'), { status: 400 })
        }

        try {
          const internal = request.headers.get('x-opencroft-internal') === '1'
          const result = await handleMethod(body.method, body.params as Record<string, unknown> | undefined, {
            signal: request.signal,
            internal,
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
          return Response.json(mcpErr(body.id ?? null, err.code ?? -32603, err.message ?? 'Internal error'), {
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
