'use server';

import { resolveGraphContexts } from '@/app/(extension-runtime)/_server/graph-context-resolver';
import { type GraphSnapshot } from '@/app/(extension-runtime)/_server/host';
import { getSetting, setSetting } from '@/app/(settings)/server/actions';

const GRAPH_SETTING_ID = 'app-dashboard-mvp-graph';

export interface GraphData {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export async function loadGraph(): Promise<GraphData> {
  const setting = await getSetting<GraphData>(GRAPH_SETTING_ID);
  return setting?.data ?? { nodes: [], edges: [] };
}

export async function saveGraph(data: GraphData): Promise<void> {
  // Resolve all exposeOutput contexts before saving
  const snapshot: GraphSnapshot = {
    nodes: data.nodes as unknown as GraphSnapshot['nodes'],
    edges: data.edges as unknown as GraphSnapshot['edges'],
  };
  const resolved = await resolveGraphContexts(snapshot);
  await setSetting<GraphData>(GRAPH_SETTING_ID, {
    nodes: resolved.nodes as unknown as GraphData['nodes'],
    edges: resolved.edges as unknown as GraphData['edges'],
  });
}
