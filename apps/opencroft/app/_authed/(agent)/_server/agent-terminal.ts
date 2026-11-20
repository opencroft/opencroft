// An agent whose node has a terminal picked runs its harness through that
// terminal (agent-placement-shared.ts). This is the server's side of it: the
// shell agent-client starts the harness with, the directory it works in
// there, and the address the harness reaches the engine's MCP server at from
// there.

import { agentRefusalOf, type TerminalContext } from '@opencroft/terminal'
import { getBackend } from '@opencroft/terminal/server'
import { getRequest } from '@tanstack/react-start/server'
import { placedShell } from 'agent-client/harness-process'
import type { RemoteShell } from 'agent-client/types'

import {
  type AgentPlacement,
  agentTerminalShell,
  placementOnTerminal,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/agent-placement-shared'
import { describeGraphRefsImpl } from '@/app/_authed/(extension-runtime)/_server/graph-refs'

/** The path this server relays a far harness's MCP requests on (`agent-mcp.ts`). */
export const AGENT_MCP_PATH = '/agent-mcp'

/**
 * The shell an agent runs through on the terminal `target`, the id its
 * selection names it by (agent-client's `shells`).
 */
export function agentShell(target: string): RemoteShell {
  return agentTerminalShell<TerminalContext>(
    target,
    {
      // Imported when used: the host module reaches this one back through the
      // agent client instance.
      getContext: async (nodeId, handleId) => {
        const { resolveTerminalTarget } = await import('@/app/_authed/(extension-runtime)/_server/host')
        return resolveTerminalTarget(`${nodeId}/${handleId}`)
      },
      agentRefusalOf,
      spawn: (ctx, argv, opts) => getBackend(ctx).spawn(ctx, argv, opts),
      ownerName: async (asked) => {
        const info = (await describeGraphRefsImpl([asked]))[asked]
        return info ? info.title || info.name || info.type.split('.').pop() : undefined
      },
    },
    () => `${publicOrigin()}${AGENT_MCP_PATH}`,
  )
}

/**
 * An agent's placement as its terminal has it (placementOnTerminal): an empty
 * Folder named, a missing one refused with FolderMissingError.
 */
export async function terminalPlacement(placement: AgentPlacement): Promise<AgentPlacement> {
  if (!placement.terminal) {
    return placement
  }
  const shell = agentShell(placement.terminal)
  const run = placedShell({ kind: 'shell', shell: shell.id }, (id) => (id === shell.id ? shell : undefined))
  return placementOnTerminal(placement, run, (await shell.describe?.()) ?? `terminal ${shell.id}`)
}

const globalRef = globalThis as typeof globalThis & { __agentPublicOrigin?: string }

/**
 * Where this server is reached from outside: `OPENCROFT_PUBLIC_URL` when set;
 * else the origin a browser reached it at, read off the request a session is
 * opened in and kept for opens no browser asked for (a message from another
 * agent). Called while a session opens, so a session opened by a person always
 * finds one.
 */
export function publicOrigin(): string {
  const configured = process.env.OPENCROFT_PUBLIC_URL?.trim()
  if (configured) {
    return configured.replace(/\/+$/, '')
  }
  const seen = requestOrigin()
  if (seen) {
    globalRef.__agentPublicOrigin = seen
  }
  const origin = seen ?? globalRef.__agentPublicOrigin
  if (!origin) {
    throw new Error(
      'An agent run through a terminal reaches OpenCroft at its public address, and none is known yet: ' +
        'set OPENCROFT_PUBLIC_URL, or open the chat from a browser once.',
    )
  }
  return origin
}

function requestOrigin(): string | undefined {
  let request: Request
  try {
    request = getRequest()
  } catch {
    // Not inside a request: a session opened by the server itself.
    return undefined
  }
  const url = new URL(request.url)
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || url.host
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(/:$/, '')
  // A caller on this machine says nothing about the address from outside.
  if (/^(localhost|127\.|\[::1\])/.test(host)) {
    return undefined
  }
  return `${proto}://${host}`
}
