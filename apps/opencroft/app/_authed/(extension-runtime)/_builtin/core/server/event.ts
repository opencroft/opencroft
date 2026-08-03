import host from '@ext/host'

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
    const { primary } = await host.execContext.dispatch(eventNodeId, 'exec-out', event)
    await host.graph.updateNode(eventNodeId, { data: { lastRunAt: Date.now() } })
    return primary
  } catch (err) {
    // Cross the @ext/host boundary on name, not `instanceof` — extension code
    // and the core-app dispatcher that throws NoExecTargetError may not share
    // a realm/prototype chain.
    if ((err as { name?: string } | undefined)?.name === 'NoExecTargetError') {
      throw new Error('Event has no connected handler')
    }
    throw err
  }
}
