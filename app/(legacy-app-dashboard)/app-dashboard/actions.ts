'use server';

import { getSetting, setSetting } from '@/app/(settings)/server/actions';

const GRAPH_SETTING_ID = 'app-dashboard-graph';

export interface GraphData {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export async function loadGraph(): Promise<GraphData> {
  const setting = await getSetting<GraphData>(GRAPH_SETTING_ID);
  return setting?.data ?? { nodes: [], edges: [] };
}

export async function saveGraph(data: GraphData): Promise<void> {
  await setSetting<GraphData>(GRAPH_SETTING_ID, data);
}
