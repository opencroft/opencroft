// Generic pub/sub for server-pushed node-data updates. The SSE bridge
// emits via `emit(...)`; the canvas subscribes once and merges the new
// data into React Flow's nodes state. This is the client-side companion
// to the server's `updateNodeData` helper — together they form a generic
// "server changed a node's data, refresh it in-place" channel.

'use client';

type Listener = (nodeId: string, data: Record<string, unknown>) => void;

const listeners = new Set<Listener>();

export function subscribeNodeDataUpdates(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitNodeDataUpdate(nodeId: string, data: Record<string, unknown>): void {
  for (const l of listeners) {
    l(nodeId, data);
  }
}
