import { execFile } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'

import { db } from '@opencroft/db'
import type { HostSecretsApi } from '@opencroft/server'
import type { ExecOptions, ExecResult, ServerConfig, TerminalContext } from '@opencroft/terminal'
import {
  exec,
  resolveKeyContent,
  sshExec,
  terminalExec,
  terminalExecResult,
  terminalRun,
  terminalRunResult,
} from '@opencroft/terminal/server'

import { dispatchExecutionContext, type ExecDispatchSummary } from '@/app/(extension-runtime)/_server/exec-dispatch'
import {
  deliverToSendMessageNode,
  type GraphEdgeLike as SendMessageEdgeLike,
  type GraphNodeLike as SendMessageNodeLike,
} from '@/app/(extension-runtime)/_server/stream'
import { slug } from '@/app/(server)/_server/types'
import { getSetting, setSetting } from '@/app/(settings)/_server/actions'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
import type { GraphData } from '@/app/(space)/_server/types'
import { toastStore } from '@/lib/toast-store'
import { cacheDir } from '@/server/cache'
import { decrypt, encrypt } from '@/server/crypto'
import { dataDir } from '@/server/data-dir'
import { secrets } from '@/server/secrets'

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

// CSPRNG-backed, uniform over `charset` (crypto.randomInt rejection-samples
// internally — no modulo bias). For generating secret values from a specific
// charset/format, unlike randomToken which is always hex.
function randomString(length: number, charset: string): string {
  if (!charset) {
    throw new Error('charset must not be empty')
  }
  let out = ''
  for (let i = 0; i < length; i++) {
    out += charset[randomInt(charset.length)]
  }
  return out
}

export interface GraphNodeRecord {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface GraphEdgeRecord {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  data?: Record<string, unknown>
}

export interface GraphSnapshot {
  nodes: GraphNodeRecord[]
  edges: GraphEdgeRecord[]
}

async function loadAllSpaces(): Promise<{ slug: string; graph: GraphData }[]> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  return r.list().map((s) => {
    const space = r.getBySlug(s.slug)!
    return { slug: s.slug, graph: space.graph }
  })
}

function findNodeAcrossSpaces(
  spaces: { slug: string; graph: GraphData }[],
  nodeId: string,
): { slug: string; node: GraphNodeRecord } | null {
  for (const s of spaces) {
    const node = s.graph.nodes.find((n) => (n as { id?: string }).id === nodeId)
    if (node) {
      return { slug: s.slug, node: node as unknown as GraphNodeRecord }
    }
  }
  return null
}

async function readGraph(): Promise<GraphSnapshot> {
  const spaces = await loadAllSpaces()
  const nodes: GraphNodeRecord[] = []
  const edges: GraphEdgeRecord[] = []
  for (const s of spaces) {
    nodes.push(...(s.graph.nodes as unknown as GraphNodeRecord[]))
    edges.push(...(s.graph.edges as unknown as GraphEdgeRecord[]))
  }
  return { nodes, edges }
}

async function writeNodePatch(nodeId: string, mutate: (graph: GraphData) => boolean): Promise<void> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    if (!space.graph.nodes.some((n) => (n as { id?: string }).id === nodeId)) {
      continue
    }
    if (mutate(space.graph)) {
      await r.saveGraph(summary.slug, space.graph)
    }
    return
  }
}

export interface HostGraphApi {
  listNodes(): Promise<GraphNodeRecord[]>
  getNode(nodeId: string): Promise<GraphNodeRecord | null>
  listNodesByType(typeId: string): Promise<GraphNodeRecord[]>
  listEdges(): Promise<GraphEdgeRecord[]>
  updateNode(nodeId: string, patch: Partial<GraphNodeRecord>): Promise<GraphNodeRecord | null>
  createNode(
    typeId: string,
    data: Record<string, unknown>,
    position: { x: number; y: number },
  ): Promise<GraphNodeRecord>
  deleteNode(nodeId: string): Promise<void>
}

const graphApi: HostGraphApi = {
  async listNodes() {
    return (await readGraph()).nodes
  },
  async getNode(nodeId) {
    const spaces = await loadAllSpaces()
    return findNodeAcrossSpaces(spaces, nodeId)?.node ?? null
  },
  async listNodesByType(typeId) {
    const graph = await readGraph()
    return graph.nodes.filter((n) => n.type === typeId)
  },
  async listEdges() {
    return (await readGraph()).edges
  },
  async updateNode(nodeId, patch) {
    let updated: GraphNodeRecord | null = null
    await writeNodePatch(nodeId, (graph) => {
      const node = graph.nodes.find((n) => (n as { id?: string }).id === nodeId) as unknown as
        | GraphNodeRecord
        | undefined
      if (!node) {
        return false
      }
      if (patch.data) {
        node.data = { ...node.data, ...patch.data }
      }
      if (patch.position) {
        node.position = patch.position
      }
      updated = node
      return true
    })
    return updated
  },
  async createNode(typeId, data, position) {
    const r = getSpacesRegistry()
    await r.ensureLoaded()
    const summaries = r.list()
    const target = (await r.getActiveSlug()) || summaries[0]?.slug
    if (!target) {
      throw new Error('No space available')
    }
    const space = r.getBySlug(target)!
    const id = crypto.randomUUID()
    const node: GraphNodeRecord = { id, type: typeId, data, position }
    space.graph.nodes.push(node as unknown as Record<string, unknown>)
    await r.saveGraph(target, space.graph)
    return node
  },
  async deleteNode(nodeId) {
    await writeNodePatch(nodeId, (graph) => {
      graph.nodes = graph.nodes.filter((n) => (n as { id?: string }).id !== nodeId)
      graph.edges = graph.edges.filter((e) => {
        const source = (e as { source?: string }).source
        const targetId = (e as { target?: string }).target
        return source !== nodeId && targetId !== nodeId
      })
      return true
    })
  },
}

// Locate a `send-message` node and its OWN space's full node/edge list — every
// lookup below (listAgents, and deliverToSendMessageNode's own agent/job
// resolution) is scoped to that one space, matching how the node's `text-in`
// wiring already resolves (by design: agents/jobs
// from other spaces are never reachable from a given SendMessage node, so
// listing them would suggest targets `send` could never actually route to).
async function findSendMessageNode(
  nodeId: string,
): Promise<{ node: GraphNodeRecord; nodes: SendMessageNodeLike[]; edges: SendMessageEdgeLike[] } | null> {
  const spaces = await loadAllSpaces()
  const found = findNodeAcrossSpaces(spaces, nodeId)
  if (!found) {
    return null
  }
  const space = spaces.find((s) => s.slug === found.slug)
  if (!space) {
    return null
  }
  return {
    node: found.node,
    nodes: space.graph.nodes as unknown as SendMessageNodeLike[],
    edges: space.graph.edges as unknown as SendMessageEdgeLike[],
  }
}

export interface HostSendMessageApi {
  send(nodeId: string, payload: Record<string, unknown>): Promise<{ sessionKey: string; created: boolean; forced: boolean }>
  listAgents(nodeId: string): Promise<{ agent: string; jobs: string[] }[]>
}

const sendMessageApi: HostSendMessageApi = {
  async send(nodeId, payload) {
    // Schema already requires `message` (see extension.json) — checked again
    // here since a caller can still pass one that resolves empty/non-string,
    // which would otherwise silently deliver the literal JSON payload as the
    // chat message via tryParseJsonMessage's plain-text fallback.
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (!message) {
      throw new Error('"message" is required and must be a non-empty string')
    }
    const found = await findSendMessageNode(nodeId)
    if (!found || found.node.type !== 'send-message') {
      throw new Error(`Send Message node not found: ${nodeId}`)
    }
    const result = await deliverToSendMessageNode(
      found.node as unknown as SendMessageNodeLike,
      found.nodes,
      found.edges,
      JSON.stringify(payload),
    )
    if (!result) {
      throw new Error('No agent/job resolved for this message — check the agent/job slugs (or this node’s own defaults) against listAgents')
    }
    return result
  },
  async listAgents(nodeId) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const jobsByAgentId = new Map<string, string[]>()
    for (const edge of found.edges) {
      const job = found.nodes.find((n) => n.id === edge.source && n.type === 'agent-job')
      const jobName = (job?.data?.['name'] as string | undefined)?.trim()
      if (!job || !jobName) {
        continue
      }
      const list = jobsByAgentId.get(edge.target) ?? []
      list.push(slug(jobName))
      jobsByAgentId.set(edge.target, list)
    }
    const out: { agent: string; jobs: string[] }[] = []
    for (const node of found.nodes) {
      if (node.type !== 'agent') {
        continue
      }
      const name = (node.data?.['name'] as string | undefined)?.trim()
      if (!name) {
        continue
      }
      out.push({ agent: slug(name), jobs: jobsByAgentId.get(node.id) ?? [] })
    }
    return out
  },
}

// Resolve a terminal-context value from a node's output handle by invoking the
// owning extension's exposeOutput. Lazy imports avoid the host<->loader cycle.
async function getTerminalContext(nodeId: string, handleId: string): Promise<TerminalContext> {
  const node = await graphApi.getNode(nodeId)
  if (!node?.type) {
    throw new Error(`Node not found: ${nodeId}`)
  }
  const { listExtensionManifests } = await import('@/app/(extension-runtime)/_server/actions')
  const manifests = await listExtensionManifests()
  const manifest = manifests.find((m) => m.nodes?.some((n) => n.typeId === node.type))
  if (!manifest) {
    throw new Error(`No extension provides node type: ${node.type}`)
  }
  const { getExtensionModule } = await import('@/app/(extension-runtime)/_server/loader')
  const mod = await getExtensionModule(manifest.id)
  const value = mod.exposeOutput?.(handleId, node.data, node.type)
  if (value === undefined || value === null) {
    throw new Error(`No context value for ${nodeId}/${handleId}`)
  }
  return value as TerminalContext
}

function dispatchExecutionContextForHost(
  sourceNodeId: string,
  sourceHandleId: string,
  event: unknown,
): Promise<ExecDispatchSummary> {
  return dispatchExecutionContext({ sourceNodeId, sourceHandleId, event })
}

function execFilePromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolve(stdout)
    })
  })
}

export interface ExtensionStorageApi {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

const STORAGE_SETTING_ID = 'extension-storage'

function storageApi(extensionId: string): ExtensionStorageApi {
  const prefix = `${extensionId}::`
  return {
    async get<T>(key: string): Promise<T | null> {
      const all = (await getSetting({ data: STORAGE_SETTING_ID }))?.data ?? {}
      return (all[prefix + key] as T | undefined) ?? null
    },
    async set<T>(key: string, value: T): Promise<void> {
      const all = (await getSetting({ data: STORAGE_SETTING_ID }))?.data ?? {}
      all[prefix + key] = value
      await setSetting({ data: { id: STORAGE_SETTING_ID, data: all } })
    },
    async delete(key: string): Promise<void> {
      const all = (await getSetting({ data: STORAGE_SETTING_ID }))?.data ?? {}
      delete all[prefix + key]
      await setSetting({ data: { id: STORAGE_SETTING_ID, data: all } })
    },
    async list(): Promise<string[]> {
      const all = (await getSetting({ data: STORAGE_SETTING_ID }))?.data ?? {}
      return Object.keys(all)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
    async clear(): Promise<void> {
      const all = (await getSetting({ data: STORAGE_SETTING_ID }))?.data ?? {}
      for (const k of Object.keys(all)) {
        if (k.startsWith(prefix)) {
          delete all[k]
        }
      }
      await setSetting({ data: { id: STORAGE_SETTING_ID, data: all } })
    },
  }
}

export interface ExtensionHost {
  extensionId: string
  fs: typeof fsPromises
  os: typeof nodeOs
  path: typeof nodePath
  exec: (cmd: string) => Promise<string>
  execFile: (cmd: string, args: string[]) => Promise<string>
  cacheDir: (...parts: string[]) => string
  dataDir: (...parts: string[]) => string
  crypto: {
    encrypt: typeof encrypt
    decrypt: typeof decrypt
    randomToken: typeof randomToken
    randomString: typeof randomString
  }
  db: typeof db
  secrets: HostSecretsApi
  settings: { get: typeof getSetting; set: typeof setSetting }
  graph: HostGraphApi
  storage: ExtensionStorageApi
  /** Deliver a message through a SendMessage node's own path (session reuse/
   *  create, envelope composition, hidden-by-default registration) — the same
   *  mechanism its `text-in` wiring uses, not a parallel implementation. */
  sendMessage: HostSendMessageApi
  /**
   * Fire-and-forget push to all connected clients; received in extension
   * client code via getStream(extensionId, 'events').
   */
  events: { broadcast: (name: string, payload?: Record<string, unknown>) => void }
  terminal: {
    exec(ctx: TerminalContext, command: string): Promise<string>
    run(ctx: TerminalContext, args: string[], env?: Record<string, string>): Promise<string>
    execResult(ctx: TerminalContext, command: string, opts?: ExecOptions): Promise<ExecResult>
    runResult(ctx: TerminalContext, args: string[], opts?: ExecOptions): Promise<ExecResult>
    getContext(nodeId: string, handleId: string): Promise<TerminalContext>
  }
  ssh: {
    exec(config: ServerConfig, command: string): Promise<string>
    resolveKey(keyPath?: string): Promise<string | undefined>
  }
  execContext: {
    /** Dispatch an execution-context event to every target connected to
     *  `sourceHandleId` on `sourceNodeId` (broadcast). Returns the primary
     *  target's result plus every target's outcome — see
     *  `_server/exec-dispatch.ts` for the resolution and fan-out contract. */
    dispatch(sourceNodeId: string, sourceHandleId: string, event: unknown): Promise<ExecDispatchSummary>
  }
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
    dataDir: (...parts) => dataDir('extension-data', extensionId, ...parts),
    crypto: { encrypt, decrypt, randomToken, randomString },
    db,
    secrets,
    settings: { get: getSetting, set: setSetting },
    graph: graphApi,
    storage: storageApi(extensionId),
    sendMessage: sendMessageApi,
    events: {
      broadcast: (name, payload) => {
        toastStore.broadcast({ type: 'extension_event', extensionId, name, payload })
      },
    },
    terminal: {
      exec: terminalExec,
      run: terminalRun,
      execResult: terminalExecResult,
      runResult: terminalRunResult,
      getContext: getTerminalContext,
    },
    ssh: { exec: sshExec, resolveKey: resolveKeyContent },
    execContext: { dispatch: dispatchExecutionContextForHost },
  }
}
