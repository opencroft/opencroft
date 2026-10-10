import { graph } from '@opencroft/server/graph'
import { execContext } from '@opencroft/server/terminal'

export interface EventFireResult {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  error?: string
  logs?: string
}

export async function fireEvent(eventNodeId: string, payload: unknown): Promise<EventFireResult> {
  const event = {
    type: 'event',
    nodeId: eventNodeId,
    firedAt: Date.now(),
    payload,
  }

  try {
    const { primary } = await execContext.dispatch(eventNodeId, 'exec-out', event)
    await graph.updateNode(eventNodeId, { data: { lastRunAt: Date.now() } })
    return primary as EventFireResult
  } catch (err) {
    // Cross the host boundary on name, not `instanceof` — extension code
    // and the core-app dispatcher that throws NoExecTargetError may not share
    // a realm/prototype chain.
    if ((err as { name?: string } | undefined)?.name === 'NoExecTargetError') {
      throw new Error('Event has no connected handler')
    }
    throw err
  }
}
