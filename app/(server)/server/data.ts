import { createServerFn } from '@tanstack/react-start';

import { loadGraph } from '@/app/(legacy-app-dashboard)/app-dashboard/actions';
import { resolveServer } from '@/app/(legacy-app-dashboard)/nodes/server/actions';
import { createDockerContext, detectOS, renameComposesFolder, renameDockerContext } from '@/app/(server)/server/remote';
import { Server, ServerFeature, getDockerFeature, getSshFeature, slug } from '@/app/(server)/server/types';
import { getSetting, setSetting, deleteSetting } from '@/app/(settings)/server/actions';
import { Setting } from '@/app/(settings)/server/setting';
import * as sshConfig from '@/app/(ssh)/server/ssh-config';

const INDEX_KEY = 'servers';

function serverKey(s: string) {
  return `server:${s}`;
}

interface ServerIndex {
  slugs: string[];
}

export const getServers = createServerFn({ strict: { output: false } }).handler(async (): Promise<Server[]> => {
  const index = (await getSetting({ data: INDEX_KEY })) as Setting<ServerIndex> | null;
  const slugs = index?.data.slugs ?? [];
  const results: Server[] = [];
  for (const s of slugs) {
    const row = (await getSetting({ data: serverKey(s) })) as Setting<Server> | null;
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
    results.push(await resolveServer({ data: server }));
  }

  return results;
});

export const saveServer = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((data: { server: Server; oldSlug?: string }) => data).handler(async ({ data }): Promise<void> => {
  const { server } = data;
  const oldSlug = data.oldSlug;
  const newSlug = slug(server.name);
  const renamed = oldSlug && oldSlug !== newSlug;

  if (getSshFeature(server) && server.address && !server.os) {
    try {
      server.os = await detectOS({ data: server });
    } catch {
      // SSH unreachable — save without OS
    }
  }

  // Save new data first before cleaning up old
  await setSetting({ data: { id: serverKey(newSlug), data: server } });

  const index = (await getSetting({ data: INDEX_KEY })) as Setting<ServerIndex> | null;
  const slugs = (index?.data.slugs ?? []).filter(s => s !== oldSlug);
  if (!slugs.includes(newSlug)) {
    slugs.push(newSlug);
  }
  await setSetting({ data: { id: INDEX_KEY, data: { slugs } } });

  // Clean up old resources after new data is safely persisted
  if (renamed) {
    await deleteSetting({ data: serverKey(oldSlug) });
    await renameComposesFolder({ data: { oldSlug, newSlug } }).catch(() => {});
    await renameDockerContext({ data: oldSlug }).catch(() => {});
    await sshConfig.removeServer(oldSlug).catch(() => {});
  }

  // Ensure SSH config entries exist (both local and WSL)
  await sshConfig.setServer(server).catch(() => {});

  // Create/update docker context (best-effort, after save)
  if (getDockerFeature(server) && getSshFeature(server)) {
    await createDockerContext({ data: server }).catch(() => {});
  }
});

export const deleteServer = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((name: string) => name).handler(async ({ data: name }): Promise<void> => {
  const s = slug(name);
  await deleteSetting({ data: serverKey(s) });

  const index = (await getSetting({ data: INDEX_KEY })) as Setting<ServerIndex> | null;
  if (index) {
    await setSetting({ data: { id: INDEX_KEY, data: { slugs: (index.data.slugs ?? []).filter(x => x !== s) } } });
  }

  await sshConfig.removeServer(s).catch(() => {});
});
