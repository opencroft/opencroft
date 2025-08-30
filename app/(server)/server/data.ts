'use server';

import { loadGraph } from '@/app/(legacy-app-dashboard)/app-dashboard/actions';
import { resolveServer } from '@/app/(legacy-app-dashboard)/nodes/server/actions';
import { createDockerContext, detectOS, renameComposesFolder, renameDockerContext } from '@/app/(server)/server/remote';
import { Server, ServerFeature, getDockerFeature, getSshFeature, slug } from '@/app/(server)/server/types';
import { getSetting, setSetting, deleteSetting } from '@/app/(settings)/server/actions';
import * as sshConfig from '@/app/(ssh)/server/ssh-config';

const INDEX_KEY = 'servers';

function serverKey(s: string) {
  return `server:${s}`;
}

interface ServerIndex {
  slugs: string[];
}

export async function getServers(): Promise<Server[]> {
  const index = await getSetting<ServerIndex>(INDEX_KEY);
  const slugs = index?.data.slugs ?? [];
  const results: Server[] = [];
  for (const s of slugs) {
    const row = await getSetting<Server>(serverKey(s));
    if (row) {
      results.push(row.data);
    }
  }

  const graph = await loadGraph();
  const serverNodes = graph.nodes.filter((n) => n.type === 'server');
  const existingSlugs = new Set(results.map((r) => slug(r.name)));
  for (const node of serverNodes) {
    const data = node.data as { name?: string; address?: string; features?: ServerFeature[] };
    if (!data.name || existingSlugs.has(slug(data.name))) {
      continue;
    }
    const server: Server = { name: data.name, address: data.address ?? '', features: data.features ?? [] };
    results.push(await resolveServer(server));
  }

  return results;
}

export async function saveServer(server: Server, oldSlug?: string): Promise<void> {
  const newSlug = slug(server.name);
  const renamed = oldSlug && oldSlug !== newSlug;

  if (getSshFeature(server) && server.address && !server.os) {
    try {
      server.os = await detectOS(server);
    } catch {
      // SSH unreachable — save without OS
    }
  }

  // Save new data first before cleaning up old
  await setSetting(serverKey(newSlug), server);

  const index = await getSetting<ServerIndex>(INDEX_KEY);
  const slugs = (index?.data.slugs ?? []).filter(s => s !== oldSlug);
  if (!slugs.includes(newSlug)) {
    slugs.push(newSlug);
  }
  await setSetting(INDEX_KEY, { slugs });

  // Clean up old resources after new data is safely persisted
  if (renamed) {
    await deleteSetting(serverKey(oldSlug));
    await renameComposesFolder(oldSlug, newSlug).catch(() => {});
    await renameDockerContext(oldSlug).catch(() => {});
    await sshConfig.removeServer(oldSlug).catch(() => {});
  }

  // Ensure SSH config entries exist (both local and WSL)
  await sshConfig.setServer(server).catch(() => {});

  // Create/update docker context (best-effort, after save)
  if (getDockerFeature(server) && getSshFeature(server)) {
    await createDockerContext(server).catch(() => {});
  }
}

export async function deleteServer(name: string): Promise<void> {
  const s = slug(name);
  await deleteSetting(serverKey(s));

  const index = await getSetting<ServerIndex>(INDEX_KEY);
  if (index) {
    await setSetting(INDEX_KEY, { slugs: (index.data.slugs ?? []).filter(x => x !== s) });
  }

  await sshConfig.removeServer(s).catch(() => {});
}
