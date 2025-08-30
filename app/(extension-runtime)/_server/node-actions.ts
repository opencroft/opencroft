'use server';

import { resolveGraphContexts } from '@/app/(extension-runtime)/_server/graph-context-resolver';
import { type GraphSnapshot } from '@/app/(extension-runtime)/_server/host';
import { loadAllManifests, getExtensionModule } from '@/app/(extension-runtime)/_server/loader';
import {
  type ConnectedSource,
  type NodeActionCtx,
  type NodeActionCtxNode,
  type NodeActionDescriptor,
  type ResolvedInput,
} from '@/app/(extension-runtime)/_types';
import { getSpacesRegistry } from '@/app/(space)/server/store';
import { type GraphData } from '@/app/(space)/server/types';

const ERRORS_KEY = '__errors';

interface GraphNodeLike {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  style?: Record<string, unknown>;
}

interface GraphEdgeLike {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface ResolvedHandle {
  sourceNodeId?: string;
  sourceHandleId?: string;
  contextType?: string;
  value?: unknown;
}

interface FoundNode {
  slug: string;
  graph: GraphData;
  node: GraphNodeLike;
}

async function findNodeWithGraph(nodeId: string): Promise<FoundNode | null> {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug);
    if (!space) {
      continue;
    }
    const hasNode = space.graph.nodes.some((n) => (n as unknown as GraphNodeLike).id === nodeId);
    if (!hasNode) {
      continue;
    }
    const snapshot: GraphSnapshot = {
      nodes: space.graph.nodes as unknown as GraphSnapshot['nodes'],
      edges: space.graph.edges as unknown as GraphSnapshot['edges'],
    };
    const resolved = await resolveGraphContexts(snapshot);
    const graph = {
      nodes: resolved.nodes as unknown as GraphData['nodes'],
      edges: resolved.edges as unknown as GraphData['edges'],
    };
    const node = graph.nodes.find((n) => (n as unknown as GraphNodeLike).id === nodeId) as unknown as GraphNodeLike;
    return { slug: summary.slug, graph, node };
  }
  return null;
}

function nodesAsLike(graph: GraphData): GraphNodeLike[] {
  return graph.nodes as unknown as GraphNodeLike[];
}

function edgesAsLike(graph: GraphData): GraphEdgeLike[] {
  return graph.edges as unknown as GraphEdgeLike[];
}

function buildCtx(
  graph: GraphData,
  node: GraphNodeLike,
  params: Record<string, unknown>,
): NodeActionCtx {
  const data = node.data ?? {};
  const resolved = (data['__resolvedContexts'] as Record<string, ResolvedHandle> | undefined) ?? {};
  const allNodes = nodesAsLike(graph);
  const allEdges = edgesAsLike(graph);

  const input = <T,>(handleId: string): T | undefined => {
    return resolved[handleId]?.value as T | undefined;
  };

  const inputSource = <T,>(handleId: string): ResolvedInput<T> | undefined => {
    const entry = resolved[handleId];
    if (!entry || entry.sourceNodeId === undefined) {
      return undefined;
    }
    return {
      sourceNodeId: entry.sourceNodeId,
      sourceHandleId: entry.sourceHandleId ?? '',
      contextType: entry.contextType ?? '',
      value: entry.value as T,
    };
  };

  const connectedSources = (handleId: string): ConnectedSource[] => {
    const matches: ConnectedSource[] = [];
    for (const edge of allEdges) {
      if (edge.target !== node.id || edge.targetHandle !== handleId) {
        continue;
      }
      const source = allNodes.find((n) => n.id === edge.source);
      if (!source) {
        continue;
      }
      matches.push({
        nodeId: source.id,
        handleId: edge.sourceHandle ?? '',
        type: source.type,
        data: source.data ?? {},
      });
    }
    return matches;
  };

  const containingNodes = (typeId?: string): NodeActionCtxNode[] => {
    const sx = node.position?.x ?? 0;
    const sy = node.position?.y ?? 0;
    return allNodes
      .filter((n) => {
        if (n.id === node.id) {
          return false;
        }
        if (typeId && n.type !== typeId) {
          return false;
        }
        const px = n.position?.x ?? 0;
        const py = n.position?.y ?? 0;
        const w = (n.style?.['width'] as number | undefined) ?? 200;
        const h = (n.style?.['height'] as number | undefined) ?? 160;
        return sx >= px && sy >= py && sx < px + w && sy < py + h;
      })
      .map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: 0, y: 0 },
        data: n.data ?? {},
      }));
  };

  return {
    nodeId: node.id,
    typeId: node.type ?? '',
    data,
    params,
    input,
    inputSource,
    connectedSources,
    containingNodes,
  };
}

export async function listNodeActions(nodeId: string): Promise<NodeActionDescriptor[]> {
  const found = await findNodeWithGraph(nodeId);
  if (!found || !found.node.type) {
    return [];
  }
  const manifests = await loadAllManifests();
  for (const manifest of manifests) {
    const meta = manifest.nodes?.find((n) => n.typeId === found.node.type);
    if (!meta?.actions) {
      continue;
    }
    return meta.actions.map((a) => ({
      nodeId,
      typeId: found.node.type ?? '',
      extensionId: manifest.id,
      actionId: a.id,
      label: a.label,
      description: a.description,
    }));
  }
  return [];
}

async function persistErrors(found: FoundNode, errors: string[]): Promise<void> {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  const space = r.getBySlug(found.slug);
  if (!space) {
    return;
  }
  const node = space.graph.nodes.find((n) => (n as unknown as GraphNodeLike).id === found.node.id) as unknown as GraphNodeLike | undefined;
  if (!node) {
    return;
  }
  const data = (node.data ??= {});
  if (errors.length > 0) {
    data[ERRORS_KEY] = errors;
  } else {
    delete data[ERRORS_KEY];
  }
  await r.saveGraph(found.slug, space.graph);
}

export async function dispatchNodeAction(
  nodeId: string,
  actionId: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const found = await findNodeWithGraph(nodeId);
  if (!found) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  const typeId = found.node.type;
  if (!typeId) {
    throw new Error(`Node ${nodeId} has no typeId`);
  }
  const manifests = await loadAllManifests();
  const owning = manifests.find((m) => m.nodes?.some((n) => n.typeId === typeId));
  if (!owning) {
    throw new Error(`No extension declares node typeId "${typeId}"`);
  }
  const mod = await getExtensionModule(owning.id);
  const handler = mod.nodeActions?.[typeId]?.[actionId];
  if (!handler) {
    throw new Error(`Extension ${owning.id} has no nodeAction "${typeId}.${actionId}"`);
  }
  const ctx = buildCtx(found.graph, found.node, params);
  await persistErrors(found, []);
  try {
    const result = await handler(ctx);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persistErrors(found, [message]);
    throw err;
  }
}
