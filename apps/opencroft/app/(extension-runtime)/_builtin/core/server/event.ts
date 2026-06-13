import host from '@ext/host'
import type { TerminalContext } from '@opencroft/server'

import { type HandlerResult, runHandler } from './script'

interface GraphNodeRecord {
  id: string
  type?: string
  data: Record<string, unknown>
}

interface GraphEdgeRecord {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

interface ServerNodeData {
  address?: string
  port?: number
  username?: string
  password?: string
  keyPath?: string
}

interface WslNodeData {
  distro?: string
}

function buildHandlerContext(node: GraphNodeRecord): TerminalContext {
  if (node.type === 'wsl') {
    const d = node.data as WslNodeData
    return { type: 'wsl', distro: d.distro ?? 'Ubuntu' }
  }
  if (node.type === 'server') {
    const d = node.data as ServerNodeData
    return {
      type: 'ssh',
      host: d.address ?? '',
      port: d.port ?? 22,
      username: d.username ?? 'root',
      password: d.password,
      keyPath: d.keyPath,
    }
  }
  return { type: 'local' }
}

export async function fireEvent(eventNodeId: string, payload: unknown): Promise<HandlerResult> {
  const edges = (await host.graph.listEdges()) as GraphEdgeRecord[]
  const handlerEdge = edges.find((e) => e.source === eventNodeId && e.sourceHandle === 'exec-out')
  if (!handlerEdge) {
    throw new Error('Event has no connected handler')
  }
  const handlerNode = (await host.graph.getNode(handlerEdge.target)) as GraphNodeRecord | null
  if (!handlerNode) {
    throw new Error('Handler node not found')
  }
  const language = handlerNode.data.language as string | undefined
  if (language !== 'python' && language !== 'node') {
    throw new Error(
      `Unsupported handler language: ${language ?? 'none'}. Only Python and Node.js scripts support ExecutionContext.`,
    )
  }
  const ctxEdge = edges.find((e) => e.target === handlerNode.id && e.targetHandle === 'ctx-in')
  let context: TerminalContext = { type: 'local' }
  if (ctxEdge) {
    const ctxNode = (await host.graph.getNode(ctxEdge.source)) as GraphNodeRecord | null
    if (ctxNode) {
      context = buildHandlerContext(ctxNode)
    }
  }
  const event = {
    type: 'event',
    nodeId: eventNodeId,
    firedAt: Date.now(),
    payload,
  }
  const result = await runHandler({
    script: (handlerNode.data.script as string | undefined) ?? '',
    language,
    context,
    event,
  })
  await host.graph.updateNode(eventNodeId, { data: { lastRunAt: Date.now() } })
  return result
}
