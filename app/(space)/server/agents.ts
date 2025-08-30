'use server';

import { getSpacesRegistry } from '@/app/(space)/server/store';

export interface AgentJobRef {
  nodeId: string;
  name: string;
  context: string;
  workingDirectory: string;
}

export interface AgentNodeRef {
  nodeId: string;
  name: string;
  spaceSlug: string;
  spaceName: string;
  jobs: AgentJobRef[];
}

interface NodeShape {
  id?: string;
  type?: string;
  data?: { name?: string; context?: string; workingDirectory?: string };
}

interface EdgeShape {
  source?: string;
  sourceHandle?: string;
  target?: string;
  targetHandle?: string;
}

export async function listAgentNodes(): Promise<AgentNodeRef[]> {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  const out: AgentNodeRef[] = [];
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug);
    if (!space) {
      continue;
    }
    const nodes = space.graph.nodes as NodeShape[];
    const edges = space.graph.edges as EdgeShape[];
    const jobsByAgent = new Map<string, AgentJobRef[]>();
    const jobsById = new Map<string, NodeShape>();
    for (const node of nodes) {
      if (node.type === 'agent-job' && node.id) {
        jobsById.set(node.id, node);
      }
    }
    for (const edge of edges) {
      if (!edge.source || !edge.target) {
        continue;
      }
      const job = jobsById.get(edge.source);
      if (!job) {
        continue;
      }
      const list = jobsByAgent.get(edge.target) ?? [];
      list.push({
        nodeId: edge.source,
        name: job.data?.name?.trim() || 'Job',
        context: job.data?.context ?? '',
        workingDirectory: job.data?.workingDirectory ?? '',
      });
      jobsByAgent.set(edge.target, list);
    }
    for (const node of nodes) {
      if (node.type !== 'agent' || !node.id) {
        continue;
      }
      out.push({
        nodeId: node.id,
        name: node.data?.name?.trim() || 'Agent',
        spaceSlug: space.slug,
        spaceName: space.name,
        jobs: jobsByAgent.get(node.id) ?? [],
      });
    }
  }
  return out;
}
