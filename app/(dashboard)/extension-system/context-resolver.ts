import { type Edge, type Node } from '@xyflow/react';

import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry';
import { type ResolvedContext } from '@/app/(extension-runtime)/_types';

export interface GraphSnapshot {
  nodes: Node[];
  edges: Edge[];
}

export function resolveHandleContext(
  targetNodeId: string,
  targetHandleId: string,
  graph: GraphSnapshot,
): ResolvedContext | null {
  const edge = graph.edges.find(
    (e) => e.target === targetNodeId && e.targetHandle === targetHandleId,
  );
  if (!edge) {
    return null;
  }

  const sourceNode = graph.nodes.find((n) => n.id === edge.source);
  if (!sourceNode?.type) {
    return null;
  }

  const resolved = extensionRegistry.resolveNode(sourceNode.type);
  if (!resolved?.exposeOutput) {
    return null;
  }

  const sourceHandleId = edge.sourceHandle;
  if (!sourceHandleId) {
    return null;
  }

  const handleDef = resolved.handles.find((h) => h.id === sourceHandleId);
  if (!handleDef) {
    return null;
  }

  const value = resolved.exposeOutput(sourceHandleId, sourceNode.data as Record<string, unknown>, sourceNode.type, sourceNode.id);
  if (value === undefined || value === null) {
    return null;
  }

  return {
    sourceNodeId: sourceNode.id,
    sourceHandleId,
    type: handleDef.contextType,
    value,
  };
}

export function resolveAllInputContexts(
  nodeId: string,
  graph: GraphSnapshot,
): Record<string, ResolvedContext> {
  const resolved = extensionRegistry.resolveNode(nodeId);
  if (!resolved) {
    return {};
  }
  const result: Record<string, ResolvedContext> = {};
  for (const handle of resolved.handles) {
    if (handle.role !== 'target') {
      continue;
    }
    const ctx = resolveHandleContext(nodeId, handle.id, graph);
    if (ctx) {
      result[handle.id] = ctx;
    }
  }
  return result;
}
