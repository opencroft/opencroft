'use client';

import { useNodes, useEdges } from '@xyflow/react';
import { useMemo } from 'react';

import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry';
import { findExtensionHandle, type ResolvedContext } from '@/app/(extension-runtime)/_types';

export function useNodeContext<V = unknown>(
  nodeId: string,
  targetHandleId: string,
): ResolvedContext<V> | null {
  const nodes = useNodes();
  const edges = useEdges();

  const edge = edges.find((e) => e.target === nodeId && e.targetHandle === targetHandleId);
  const sourceNode = edge ? nodes.find((n) => n.id === edge.source) : undefined;
  const sourceData = sourceNode?.data;
  const sourceType = sourceNode?.type;
  const sourceId = sourceNode?.id;
  const sourceHandleId = edge?.sourceHandle ?? undefined;

  return useMemo(() => {
    if (!sourceId || !sourceType || !sourceHandleId || !sourceData) {
      return null;
    }
    const resolved = extensionRegistry.resolveNode(sourceType);
    if (!resolved?.exposeOutput) {
      return null;
    }
    const handleDef = findExtensionHandle(resolved.handles, sourceHandleId, 'source');
    if (!handleDef) {
      return null;
    }
    const value = resolved.exposeOutput(sourceHandleId, sourceData as Record<string, unknown>, sourceType, sourceId);
    if (value === undefined || value === null) {
      return null;
    }
    return {
      sourceNodeId: sourceId,
      sourceHandleId,
      type: handleDef.contextType,
      value,
    } as ResolvedContext<V>;
  }, [sourceId, sourceType, sourceHandleId, sourceData]);
}
