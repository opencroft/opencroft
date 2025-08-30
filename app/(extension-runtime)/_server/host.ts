import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

import { getSetting, setSetting } from '@/app/(settings)/server/actions';
import { getSpacesRegistry } from '@/app/(space)/server/store';
import { type GraphData } from '@/app/(space)/server/types';
import { cacheDir } from '@/server/cache';
import { decrypt, encrypt } from '@/server/crypto';
import { prisma } from '@/server/prisma';
import { exec } from '@/server/shell';

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export interface GraphNodeRecord {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface GraphEdgeRecord {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
}

async function loadAllSpaces(): Promise<{ slug: string; graph: GraphData }[]> {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  return r.list().map((s) => {
    const space = r.getBySlug(s.slug)!;
    return { slug: s.slug, graph: space.graph };
  });
}

function findNodeAcrossSpaces(spaces: { slug: string; graph: GraphData }[], nodeId: string): { slug: string; node: GraphNodeRecord } | null {
  for (const s of spaces) {
    const node = s.graph.nodes.find((n) => (n as { id?: string }).id === nodeId);
    if (node) {
      return { slug: s.slug, node: node as unknown as GraphNodeRecord };
    }
  }
  return null;
}

async function readGraph(): Promise<GraphSnapshot> {
  const spaces = await loadAllSpaces();
  const nodes: GraphNodeRecord[] = [];
  const edges: GraphEdgeRecord[] = [];
  for (const s of spaces) {
    nodes.push(...(s.graph.nodes as unknown as GraphNodeRecord[]));
    edges.push(...(s.graph.edges as unknown as GraphEdgeRecord[]));
  }
  return { nodes, edges };
}

async function writeNodePatch(nodeId: string, mutate: (graph: GraphData) => boolean): Promise<void> {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug);
    if (!space) {
      continue;
    }
    if (!space.graph.nodes.some((n) => (n as { id?: string }).id === nodeId)) {
      continue;
    }
    if (mutate(space.graph)) {
      await r.saveGraph(summary.slug, space.graph);
    }
    return;
  }
}

export interface HostGraphApi {
  listNodes(): Promise<GraphNodeRecord[]>;
  getNode(nodeId: string): Promise<GraphNodeRecord | null>;
  listNodesByType(typeId: string): Promise<GraphNodeRecord[]>;
  listEdges(): Promise<GraphEdgeRecord[]>;
  updateNode(nodeId: string, patch: Partial<GraphNodeRecord>): Promise<GraphNodeRecord | null>;
  createNode(
    typeId: string,
    data: Record<string, unknown>,
    position: { x: number; y: number },
  ): Promise<GraphNodeRecord>;
  deleteNode(nodeId: string): Promise<void>;
}

const graphApi: HostGraphApi = {
  async listNodes() {
    return (await readGraph()).nodes;
  },
  async getNode(nodeId) {
    const spaces = await loadAllSpaces();
    return findNodeAcrossSpaces(spaces, nodeId)?.node ?? null;
  },
  async listNodesByType(typeId) {
    const graph = await readGraph();
    return graph.nodes.filter((n) => n.type === typeId);
  },
  async listEdges() {
    return (await readGraph()).edges;
  },
  async updateNode(nodeId, patch) {
    let updated: GraphNodeRecord | null = null;
    await writeNodePatch(nodeId, (graph) => {
      const node = graph.nodes.find((n) => (n as { id?: string }).id === nodeId) as unknown as GraphNodeRecord | undefined;
      if (!node) {
        return false;
      }
      if (patch.data) {
        node.data = { ...node.data, ...patch.data };
      }
      if (patch.position) {
        node.position = patch.position;
      }
      updated = node;
      return true;
    });
    return updated;
  },
  async createNode(typeId, data, position) {
    const r = getSpacesRegistry();
    await r.ensureLoaded();
    const summaries = r.list();
    const target = (await r.getActiveSlug()) || summaries[0]?.slug;
    if (!target) {
      throw new Error('No space available');
    }
    const space = r.getBySlug(target)!;
    const id = crypto.randomUUID();
    const node: GraphNodeRecord = { id, type: typeId, data, position };
    space.graph.nodes.push(node as unknown as Record<string, unknown>);
    await r.saveGraph(target, space.graph);
    return node;
  },
  async deleteNode(nodeId) {
    await writeNodePatch(nodeId, (graph) => {
      graph.nodes = graph.nodes.filter((n) => (n as { id?: string }).id !== nodeId);
      graph.edges = graph.edges.filter((e) => {
        const source = (e as { source?: string }).source;
        const targetId = (e as { target?: string }).target;
        return source !== nodeId && targetId !== nodeId;
      });
      return true;
    });
  },
};

function execFilePromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export interface ExtensionStorageApi {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

const STORAGE_SETTING_ID = 'extension-storage';

function storageApi(extensionId: string): ExtensionStorageApi {
  const prefix = `${extensionId}::`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const all = (await getSetting<Record<string, unknown>>(STORAGE_SETTING_ID))?.data ?? {};
      return (all[prefix + key] as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      const all = (await getSetting<Record<string, unknown>>(STORAGE_SETTING_ID))?.data ?? {};
      all[prefix + key] = value;
      await setSetting<Record<string, unknown>>(STORAGE_SETTING_ID, all);
    },
    async delete(key: string): Promise<void> {
      const all = (await getSetting<Record<string, unknown>>(STORAGE_SETTING_ID))?.data ?? {};
      delete all[prefix + key];
      await setSetting<Record<string, unknown>>(STORAGE_SETTING_ID, all);
    },
    async list(): Promise<string[]> {
      const all = (await getSetting<Record<string, unknown>>(STORAGE_SETTING_ID))?.data ?? {};
      return Object.keys(all)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
    async clear(): Promise<void> {
      const all = (await getSetting<Record<string, unknown>>(STORAGE_SETTING_ID))?.data ?? {};
      for (const k of Object.keys(all)) {
        if (k.startsWith(prefix)) {
          delete all[k];
        }
      }
      await setSetting<Record<string, unknown>>(STORAGE_SETTING_ID, all);
    },
  };
}

export interface ExtensionHost {
  extensionId: string;
  fs: typeof fsPromises;
  os: typeof nodeOs;
  path: typeof nodePath;
  exec: (cmd: string) => Promise<string>;
  execFile: (cmd: string, args: string[]) => Promise<string>;
  cacheDir: (...parts: string[]) => string;
  crypto: { encrypt: typeof encrypt; decrypt: typeof decrypt; randomToken: typeof randomToken };
  prisma: typeof prisma;
  settings: { get: typeof getSetting; set: typeof setSetting };
  graph: HostGraphApi;
  storage: ExtensionStorageApi;
}

export function createHost(extensionId: string): ExtensionHost {
  return {
    extensionId,
    fs: fsPromises,
    os: nodeOs,
    path: nodePath,
    exec,
    execFile: execFilePromise,
    cacheDir: (...parts) => cacheDir('extensions', extensionId, ...parts),
    crypto: { encrypt, decrypt, randomToken },
    prisma,
    settings: { get: getSetting, set: setSetting },
    graph: graphApi,
    storage: storageApi(extensionId),
  };
}
