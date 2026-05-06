import { NextRequest, NextResponse } from 'next/server';

import { toolDefinitions, handleToolCall, getAgentToolDefinitions } from '@/app/(mcp)/api/mcp/tools';

type MCPRequest = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

type MCPResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function mcpRes(id: number | string | null, result: unknown): MCPResponse {
  return { jsonrpc: '2.0', id, result };
}

function mcpErr(id: number | string | null, code: number, message: string): MCPResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  signal?: AbortSignal,
) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'opencroft-mcp', version: '0.3.0' },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list': {
      const agentTools = await getAgentToolDefinitions();
      return { tools: [...toolDefinitions, ...agentTools] };
    }

    case 'tools/call': {
      const name = params?.name as string | undefined;
      if (!name) {
        throw { code: -32602, message: 'Missing tool name' };
      }

      const args = (params?.arguments as Record<string, unknown>) ?? {};
      return handleToolCall(name, args, signal);
    }

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

function generateSessionId(): string {
  return `opencroft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Streamable HTTP: POST — handle JSON-RPC requests
export async function POST(req: NextRequest) {
  const body = (await req.json()) as MCPRequest;

  if (body.jsonrpc !== '2.0') {
    return Response.json(mcpErr(body.id ?? null, -32600, 'Invalid Request'), { status: 400 });
  }

  try {
    const result = await handleMethod(
      body.method,
      body.params as Record<string, unknown> | undefined,
      req.signal,
    );

    // Notifications have no id and no response body
    if (body.id === null || body.id === undefined) {
      return new NextResponse(null, { status: 202 });
    }

    const sessionId = generateSessionId();
    const response = mcpRes(body.id, result);

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
      },
    });
  } catch (e: unknown) {
    const err = e as { code?: number; message?: string };
    return NextResponse.json(
      mcpErr(body.id ?? null, err.code ?? -32603, err.message ?? 'Internal error'),
      { status: 500 },
    );
  }
}

// Streamable HTTP: GET — session info (405 for stateless implementation)
export async function GET() {
  return new NextResponse(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not supported' } }),
    {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Allow': 'POST, DELETE' },
    },
  );
}

// Streamable HTTP: DELETE — terminate session (200 for stateless implementation)
export async function DELETE() {
  return new NextResponse(null, { status: 200 });
}
