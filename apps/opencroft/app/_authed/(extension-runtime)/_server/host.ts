import { execFile } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'

import * as values from '@opencroft/core/values'
import { db, spaceApp } from '@opencroft/db'
import { dataDir, instanceId } from '@opencroft/instance'
import type {
  ExecDispatchOptions,
  ExtensionServerHost,
  GraphEdgeRecord,
  GraphNodeRecord,
  HandleInfo,
  HostAgentGroupChatsApi,
  HostAgentsApi,
  HostCompactResult,
  HostExecContextApi,
  HostGraphApi,
  HostMcpTokensApi,
  HostMentionsApi,
  HostPersonGroupChatsApi,
  HostSecretsApi,
  HostSpacesApi,
  HostSshKeysApi,
  HostThreadUsage,
  HostUsageApi,
  HostUser,
  HostUsersApi,
  ListHandlesFilter,
} from '@opencroft/server'
import { agentRefusalOf, type ServerConfig, type TerminalContext } from '@opencroft/terminal'
import {
  exec,
  getBackend,
  listTerminalFolders,
  readTerminalFile,
  resolveKeyContent,
  sshExec,
  startJobSession,
  stopViewJob,
  terminalExec,
  terminalExecResult,
  terminalRun,
  terminalRunResult,
  writeTerminalFile,
} from '@opencroft/terminal/server'
import { asc } from 'drizzle-orm'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { readAgentInstructions, writeAgentInstructions } from '@/app/_authed/(agent)/_server/agent-instructions'
import { listAgentPresence, subscribeAgentPresence } from '@/app/_authed/(agent)/_server/agent-presence'
import { queryChatUsageTurnsBySessionKey } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { SEND_MESSAGE_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import { isAutolayoutSection } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { declaredTypesOf, namesCoreType, resolveCodeTypeRef } from '@/app/_authed/(extension-runtime)/_declared-types'
import { enumCasesOfManifests } from '@/app/_authed/(extension-runtime)/_enum-types'
import {
  extensionUrl,
  extensionUrlBase,
  parseType,
  resolveTypeRef,
} from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  type PlacementRequest,
  placeAbsolute,
  withoutStandingPlaces,
} from '@/app/_authed/(extension-runtime)/_frame-placement'
import {
  deletedWithContents,
  deleteKeepingChildren,
  withAbsolutePositions,
  withLevels,
} from '@/app/_authed/(extension-runtime)/_frame-tree'
import { newNodeData } from '@/app/_authed/(extension-runtime)/_node-defaults'
import { withNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { collabApiFor } from '@/app/_authed/(extension-runtime)/_server/collab-api'
import {
  appDirectoryFor,
  type DirectoryListing,
  type DirectoryViewer,
  listSpacesFor,
  subscribeDirectoryListing,
} from '@/app/_authed/(extension-runtime)/_server/directory'
import {
  dispatchExecutionContext,
  type ExecDispatchSummary,
} from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import { frameTest } from '@/app/_authed/(extension-runtime)/_server/frame-types'
import {
  callFromGraph,
  graphCallActions,
  graphCallTargets,
} from '@/app/_authed/(extension-runtime)/_server/graph-calls'
import { nodeTypeDefaults } from '@/app/_authed/(extension-runtime)/_server/provided-points'
import {
  deliverToSendMessageNode,
  type SendMessageDeliveryResult,
  type GraphEdgeLike as SendMessageEdgeLike,
  type GraphNodeLike as SendMessageNodeLike,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { wiredEdgesOf } from '@/app/_authed/(extension-runtime)/_wired-edges'
import { COMPACT_WAIT_MS, compactResultOf, waitForCompact } from '@/app/_authed/(group-chats)/_server/compact-wait'
import type { MemberPrincipal, SenderThread } from '@/app/_authed/(group-chats)/_server/model'
import { mcpTokensApi } from '@/app/_authed/(mcp)/_server/mcp-tokens'
import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl, setSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { listAgentDirectory, listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { mentionsIn } from '@/app/_server/mentions'
import { type AttributedSender, registerExtensionSystemSender, senderForSend } from '@/app/_server/message-author'
import { listUserDirectory } from '@/app/_server/user-directory'
import { newGraphId } from '@/lib/graph-id'
import { toastStore } from '@/lib/toast-store'
import { cacheDir } from '@/server/cache'
import { credentialRedactor } from '@/server/credential-redactor'
import { decrypt, encrypt } from '@/server/crypto'
import { secrets } from '@/server/secrets'
import { sshKeys } from '@/server/ssh-key-store'

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

// The graph types are the package's declarations, the ones extensions compile
// against, so `graphApi` below failing to match them is a compile error here.
export type { GraphEdgeRecord, GraphNodeRecord, HandleInfo, HostGraphApi, ListHandlesFilter }

export interface GraphSnapshot {
  nodes: GraphNodeRecord[]
  edges: GraphEdgeRecord[]
}

// One entry per GRAPH, not per space: nodes live on graphs now, and anything
// enumerating them has to see every canvas of every space.
interface GraphEntry {
  /** The graph's address (`<space>.<graph>`). */
  address: string
  spaceSlug: string
  graph: GraphData
}

async function loadAllGraphs(): Promise<GraphEntry[]> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  return r.listGraphs().map((ref) => ({
    address: r.addressOf(ref),
    spaceSlug: ref.space.slug,
    graph: ref.graph.graph,
  }))
}

// Edges as wiring reads them (see `wiredEdges`): an extension walking them
// meets the real source of a node inside a subgraph, as it would outside one.
async function readGraph(): Promise<GraphSnapshot> {
  const graphs = await loadAllGraphs()
  const nodes: GraphNodeRecord[] = []
  const edges: GraphEdgeRecord[] = []
  for (const g of graphs) {
    nodes.push(...asRead(g.graph))
    edges.push(...wiredEdgesOf<GraphEdgeRecord>(g.graph))
  }
  return { nodes, edges }
}

const EXTENSION_HOST_ORIGIN: GraphWriteOrigin = { kind: 'extension', name: 'extension host' }

/**
 * A graph's nodes as extensions read them: positions absolute, where each is
 * drawn on its level's canvas, and the subgraph a node inside one is in (see
 * `_frame-tree.ts`).
 */
function asRead(graph: GraphData): GraphNodeRecord[] {
  return withLevels(withAbsolutePositions(graph.nodes as unknown as GraphNodeRecord[]))
}

/** Applies `request` to the graph's nodes and returns the placed node as read, or throws why it is refused. */
async function place(graph: GraphData, request: PlacementRequest): Promise<GraphNodeRecord | null> {
  const placed = placeAbsolute(
    graph.nodes as unknown as GraphNodeRecord[],
    [request],
    await frameTest(),
    isAutolayoutSection,
  )
  if ('refused' in placed) {
    throw new Error(placed.refused)
  }
  graph.nodes = placed.nodes as unknown as GraphData['nodes']
  return asRead(graph).find((n) => n.id === request.id) ?? null
}

async function writeNodePatch(nodeId: string, mutate: (graph: GraphData) => void | Promise<void>): Promise<void> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const ref = r.findByNode(nodeId)
  if (!ref) {
    return
  }
  await mutateLiveGraph(r.addressOf(ref), EXTENSION_HOST_ORIGIN, mutate, { resolveContexts: false })
}

/**
 * A node or App instance with handles matching a filter, before its dynamic
 * handles are expanded. Expanding asks something at runtime -- a docker host
 * what is running, an App what it has -- and that is as slow as the thing
 * asked, up to a connection timeout, so it is each owner's own call.
 */
export interface HandleOwner {
  /** The node id, or the App instance id. */
  id: string
  spaceSlug: string
  /** The node's stored, qualified type; `app:<type>` for an App instance. */
  type: string
  /** Whether `handles()` asks anything at runtime. False means it answers from the manifest alone. */
  dynamic: boolean
  handles: () => Promise<HandleInfo[]>
}

/** Narrows an owner listing before anything is asked. */
export interface HandleOwnerScope {
  spaceSlug?: string
  /** One node id or App instance id. */
  ownerId?: string
}

/** `graphApi` for one extension: the type references it passes resolve against its own id. */
function graphApiFor(extensionId: string): HostGraphApi {
  const typeRef = async (type: string) => {
    if (!namesCoreType(type)) {
      return resolveCodeTypeRef(extensionId, type, () => false)
    }
    // Imported on use: the loader builds hosts, so it imports this module.
    const { getManifest } = await import('@/app/_authed/(extension-runtime)/_server/loader')
    // An extension whose manifest cannot be read declares nothing.
    const manifest = await getManifest(extensionId).catch(() => null)
    const declared = manifest ? declaredTypesOf(manifest) : new Set<string>()
    return resolveCodeTypeRef(extensionId, type, (qualified) => declared.has(qualified))
  }
  return {
    ...graphApi,
    listNodesByType: async (type) => graphApi.listNodesByType(await typeRef(type)),
    listHandles: async (filter) =>
      graphApi.listHandles(filter?.handleType ? { ...filter, handleType: await typeRef(filter.handleType) } : filter),
    getHandleType: async (type) => graphApi.getHandleType(await typeRef(type)),
    createNode: async (address, type, data, position) =>
      graphApi.createNode(address, await typeRef(type), data, position),
  }
}

// Takes and returns types in their stored, qualified form: what host code
// outside any extension holds.
const graphApi: HostGraphApi = {
  async listNodes() {
    return (await readGraph()).nodes
  },
  async getNode(nodeId) {
    const r = getSpacesRegistry()
    await r.ensureLoaded()
    const ref = r.findByNode(nodeId)
    return (ref ? asRead(ref.graph.graph) : []).find((n) => n.id === nodeId) ?? null
  },
  async listGraphNodes(nodeId) {
    const r = getSpacesRegistry()
    await r.ensureLoaded()
    const ref = r.findByNode(nodeId)
    return ref ? asRead(ref.graph.graph) : []
  },
  async listNodesByType(type) {
    const graph = await readGraph()
    return graph.nodes.filter((n) => n.type === type)
  },
  async listEdges() {
    return (await readGraph()).edges
  },
  async listHandles(filter) {
    // Every owner is expanded at once. In turn, one unreachable docker host
    // held up every node listed after it for its whole connection timeout.
    const owners = await listGraphHandleOwners(filter)
    return (await Promise.all(owners.map((owner) => owner.handles()))).flat()
  },
  async getHandleType(type) {
    const { loadAllManifests } = await import('@/app/_authed/(extension-runtime)/_server/loader')
    for (const manifest of await loadAllManifests()) {
      const found = manifest.handleTypes?.find((handleType) => handleType.id === type)
      if (found) {
        return found
      }
    }
    return null
  },
  async updateNode(nodeId, patch) {
    let updated: GraphNodeRecord | null = null
    await writeNodePatch(nodeId, async (graph) => {
      const node = graph.nodes.find((n) => (n as { id?: string }).id === nodeId) as unknown as
        | GraphNodeRecord
        | undefined
      if (!node) {
        return
      }
      if (patch.data) {
        node.data = { ...node.data, ...patch.data }
      }
      updated =
        patch.position || patch.parentId !== undefined
          ? await place(
              graph,
              withoutStandingPlaces(graph.nodes as unknown as GraphNodeRecord[], [
                {
                  id: nodeId,
                  ...(patch.position ? { position: patch.position } : {}),
                  ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }),
                },
              ])[0],
            )
          : (asRead(graph).find((n) => n.id === nodeId) ?? null)
    })
    return updated
  },
  async setNodeErrors(nodeId, source, errors) {
    // Read first: a check reporting the answer it reported last writes nothing,
    // and most runs of a check report what they did before.
    const stored = await graphApi.getNode(nodeId)
    if (!stored || withNodeErrors(stored.data ?? {}, source, errors) === stored.data) {
      return
    }
    await writeNodePatch(nodeId, (graph) => {
      const node = graph.nodes.find((n) => (n as { id?: string }).id === nodeId) as unknown as
        | GraphNodeRecord
        | undefined
      if (node) {
        node.data = withNodeErrors(node.data ?? {}, source, errors)
      }
    })
  },
  async createNode(address, type, data, position) {
    const r = getSpacesRegistry()
    await r.ensureLoaded()
    const ref = r.resolveGraph(address)
    if (!ref) {
      throw new Error(`Graph not found: ${address}`)
    }
    const id = newGraphId()
    const node: GraphNodeRecord = { id, type, data: newNodeData(await nodeTypeDefaults(type), data), position }
    let created = node
    await mutateLiveGraph(
      r.addressOf(ref),
      EXTENSION_HOST_ORIGIN,
      async (graph) => {
        graph.nodes.push(node as unknown as Record<string, unknown>)
        // Into the frame under its corner, as a node dropped there goes.
        created = (await place(graph, { id, position })) ?? node
      },
      { resolveContexts: false },
    )
    return created
  },
  async deleteNode(nodeId) {
    await writeNodePatch(nodeId, (graph) => {
      // A deleted frame's members stay where they are drawn, in a frame that
      // holds them; a deleted subgraph takes what is inside it.
      const nodes = graph.nodes as unknown as GraphNodeRecord[]
      const gone = deletedWithContents(nodes, new Set([nodeId]))
      graph.nodes = deleteKeepingChildren(nodes, gone) as unknown as GraphData['nodes']
      graph.edges = graph.edges.filter((e) => {
        const source = (e as { source?: string }).source
        const targetId = (e as { target?: string }).target
        return !gone.has(source ?? '') && !gone.has(targetId ?? '')
      })
    })
  },
}

/** `graph.setNodeErrors` for host code outside any extension, such as an API Route's request. */
export const setNodeErrors: HostGraphApi['setNodeErrors'] = (nodeId, source, errors) =>
  graphApi.setNodeErrors(nodeId, source, errors)

/**
 * The nodes and App instances owning handles that match `filter`, each with
 * its handles as a call of its own -- the discovery `listHandles` waits on in
 * full, exported for a caller that shows owners before their handles arrive
 * (the terminal picker). Reads the graph, the manifests and the App rows;
 * asks nothing at runtime.
 */
export async function listGraphHandleOwners(
  filter?: ListHandlesFilter,
  scope: HandleOwnerScope = {},
): Promise<HandleOwner[]> {
  // Lazy imports for the same reason getTerminalContext uses them: loader.ts
  // imports this module, so a static edge back to it would close a cycle.
  // Same manifest source as getTerminalContext, so a handle this returns is
  // one that resolver can actually resolve.
  const { listExtensionManifestsImpl } = await import('@/app/_authed/(extension-runtime)/_server/extension-action-impl')
  const { buildNodeTypeHandles, expandDynamicHandles, findDockerExtensionId } = await import(
    '@/app/_authed/(extension-runtime)/_server/node-handles'
  )
  const [graphs, manifests] = await Promise.all([loadAllGraphs(), listExtensionManifestsImpl()])
  const byType = buildNodeTypeHandles(manifests)
  const dockerExtensionId = findDockerExtensionId(manifests)
  const wanted = (handle: { role: string; handleType: string }) =>
    (filter?.role === undefined || handle.role === filter.role) &&
    (filter?.handleType === undefined || handle.handleType === filter.handleType)
  const inScope = (id: string, spaceSlug: string) =>
    (scope.ownerId === undefined || id === scope.ownerId) &&
    (scope.spaceSlug === undefined || spaceSlug === scope.spaceSlug)

  const owners: HandleOwner[] = []
  for (const entry of graphs) {
    for (const raw of entry.graph.nodes as unknown as GraphNodeRecord[]) {
      const type = raw.type
      if (!type || !inScope(raw.id, entry.spaceSlug)) {
        continue
      }
      const declared = byType.get(type)?.handles ?? []
      const matching = declared.filter(wanted)
      if (matching.length === 0) {
        continue
      }
      const base = { nodeId: raw.id, spaceSlug: entry.spaceSlug, type, nodeName: (raw.data?.name as string) || type }
      // Expansion costs a docker.ps, so it happens only when a dynamic handle
      // survived the filter -- a caller asking for targets, or for some other
      // handle type, pays nothing.
      const dynamic = matching.some((handle) => handle.dynamic)
      owners.push({
        id: raw.id,
        spaceSlug: entry.spaceSlug,
        type,
        dynamic,
        handles: async () => {
          const liveIds = dynamic ? await expandDynamicHandles(raw, declared, dockerExtensionId) : []
          return matching.flatMap((handle): HandleInfo[] => {
            const shared = {
              ...base,
              declaredId: handle.id,
              handleType: handle.handleType,
              role: handle.role,
              label: handle.label,
            }
            // A dynamic handle's declared id is only a prefix -- one entry per
            // live id instead, so every handleId returned is one that
            // terminal.getContext can actually resolve.
            return handle.dynamic
              ? liveIds
                  .filter((id) => id.startsWith(handle.id))
                  .map((id) => ({ ...shared, handleId: id, dynamic: true }))
              : [{ ...shared, handleId: handle.id, dynamic: false }]
          })
        },
      })
    }
  }
  // App instances expose handles too (addressed as <instanceId>/<handleId>),
  // and only as sources -- an App consumes contexts through its parameters.
  if (filter?.role === undefined || filter.role === 'source') {
    const { listAppHandleOwners } = await import('@/app/_authed/(apps)/_server/runtime')
    for (const app of await listAppHandleOwners(filter?.handleType)) {
      if (!inScope(app.instanceId, app.spaceSlug)) {
        continue
      }
      owners.push({
        id: app.instanceId,
        spaceSlug: app.spaceSlug,
        type: `app:${app.type}`,
        dynamic: app.dynamic,
        handles: async () =>
          (await app.handles()).map((handle) => ({
            nodeId: handle.instanceId,
            spaceSlug: handle.spaceSlug,
            type: `app:${handle.type}`,
            nodeName: handle.title,
            slug: handle.slug,
            // An instance whose space is gone has no address to give.
            ...(handle.spaceSlug ? { address: `${handle.spaceSlug}.${handle.slug}` } : {}),
            handleId: handle.handleId,
            declaredId: handle.declaredId,
            handleType: handle.handleType,
            role: 'source' as const,
            label: handle.label,
            liveLabel: handle.liveLabel,
            dynamic: handle.dynamic,
          })),
      })
    }
  }
  return owners
}

// Locate a `send-message` node and its OWN space's full node/edge list — the
// nodes are what sender attribution resolves against (see senderForSend),
// scoped to the one space the node lives in.
async function findSendMessageNode(
  nodeId: string,
): Promise<{ node: GraphNodeRecord; nodes: SendMessageNodeLike[]; edges: SendMessageEdgeLike[] } | null> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const found = r.findByNode(nodeId)
  if (!found) {
    return null
  }
  const node = found.graph.graph.nodes.find((n) => (n as { id?: string }).id === nodeId)
  if (!node) {
    return null
  }
  // The whole SPACE's wiring, across its graphs: the reachability rule is
  // space-scoped, and which canvas a node was drawn on does not narrow it.
  const graphs = [...found.space.graphs.values()]
  return {
    node: node as unknown as GraphNodeRecord,
    nodes: graphs.flatMap((g) => g.graph.nodes) as unknown as SendMessageNodeLike[],
    edges: graphs.flatMap((g) => wiredEdgesOf<SendMessageEdgeLike>(g.graph)),
  }
}

export interface HostSendMessageApi {
  /**
   * `sourceNodeId` is what fed THIS run -- the action context's input source,
   * never a graph lookup of what is wired to the handle. It is what the message
   * is attributed to, and a send whose source cannot be turned into an account
   * is refused rather than attributed to the application.
   *
   * `callerAgent` is who INVOKED the action, and it answers a different
   * question: not what produced this text, but who asked for it to be sent. It
   * decides only when nothing fed the run -- the case a direct invocation is
   * always in, and which is not the same fact as having no sender at all.
   *
   * A seam: when the execution context carries an originator of its own BOTH
   * of these go away, and the call sites stop having to remember either.
   */
  send(
    nodeId: string,
    payload: Record<string, unknown>,
    sourceNodeId: string | undefined,
    callerAgent?: string,
  ): Promise<SendMessageDeliveryResult>
}

const sendMessageApi: HostSendMessageApi = {
  async send(nodeId, payload, sourceNodeId, callerAgent) {
    // Schema already requires `message` (see extension.json) — checked again
    // here since a caller can still pass one that resolves empty/non-string,
    // which would otherwise silently deliver the literal JSON payload as the
    // chat message via tryParseJsonMessage's plain-text fallback.
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (!message) {
      throw new Error('"message" is required and must be a non-empty string')
    }
    const found = await findSendMessageNode(nodeId)
    if (!found || found.node.type !== SEND_MESSAGE_NODE_TYPE) {
      throw new Error(`Send Message node not found: ${nodeId}`)
    }
    // Established before anything is delivered, so an unattributable send
    // fails instead of arriving with the wrong name on it.
    //
    // Both facts are handed over and `senderForSend` decides between them --
    // see it for the order and for why the agent listing is a thunk rather
    // than a list.
    const sender = await senderForSend({ sourceNodeId, callerAgent }, found.nodes, listAgentNodesImpl)
    return deliverToSendMessageNode(JSON.stringify(payload), sender)
  },
}

// Resolve a terminal-context value from a node's output handle by invoking the
// owning extension's exposeOutput. Lazy imports avoid the host<->loader cycle.
async function getTerminalContext(nodeId: string, handleId: string): Promise<TerminalContext> {
  const node = await graphApi.getNode(nodeId)
  if (!node?.type) {
    // Not a graph node — an App instance's handle uses the same target syntax
    // with the app's address, or its uuid, in the node position.
    const { resolveAppHandleContext } = await import('@/app/_authed/(apps)/_server/runtime')
    const appHandle = await resolveAppHandleContext(nodeId, handleId)
    if (appHandle) {
      return appHandle.value as TerminalContext
    }
    // NOT `Node not found`. An app whose HANDLE is the miss was reported here
    // as a missing node, so the one thing the message named was the one thing
    // that was fine — and a reader went looking for a node nobody addressed.
    const { unresolvedAppTarget } = await import('@/app/_authed/(apps)/_server/app-address')
    throw new Error(await unresolvedAppTarget(nodeId, handleId))
  }
  const { listExtensionManifestsImpl } = await import('@/app/_authed/(extension-runtime)/_server/extension-action-impl')
  const manifests = await listExtensionManifestsImpl()
  const manifest = manifests.find((m) => m.nodes?.some((n) => n.type === node.type))
  const bare = parseType(node.type)?.bare
  if (!manifest || !bare) {
    throw new Error(`No extension provides node type: ${node.type}`)
  }
  const { getExtensionModule } = await import('@/app/_authed/(extension-runtime)/_server/loader')
  const mod = await getExtensionModule(manifest.id)
  const value = mod.exposeOutput?.(handleId, node.data, bare, nodeId, undefined, enumCasesOfManifests(manifests))
  if (value === undefined || value === null) {
    throw new Error(`No context value for ${nodeId}/${handleId}`)
  }
  return value as TerminalContext
}

// The same resolution for a "node-id/handle-id" target string — the form the
// TerminalSelector hands out and a Terminal Router stores per route.
export function resolveTerminalTarget(target: string): Promise<TerminalContext> {
  const slash = target.indexOf('/')
  if (slash <= 0 || slash === target.length - 1) {
    return Promise.reject(new Error(`Not a terminal target: "${target}" (expected "node-id/handle-id")`))
  }
  return getTerminalContext(target.slice(0, slash), target.slice(slash + 1))
}

function dispatchExecutionContextForHost(
  sourceNodeId: string,
  sourceHandleId: string,
  event: unknown,
  options?: ExecDispatchOptions,
): Promise<ExecDispatchSummary> {
  return dispatchExecutionContext({
    sourceNodeId,
    sourceHandleId,
    event,
    ...(options && Object.hasOwn(options, 'run') ? { run: options.run } : {}),
  })
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

/**
 * Group chats as seen by ONE sender the host has already decided: the agent
 * that invoked an App action, or the extension's own system identity. The
 * extension never names who it speaks as — see `groupChatsForCaller` — so it
 * cannot speak as an agent that did not call it.
 */
export type HostGroupChatsApi = ExtensionServerHost['groupChats']
export type { HostAgentGroupChatsApi }

// Lazy: the group-chat model reaches this module through its own imports (the
// agent client, then the extension loader), so a static import here would be a
// cycle.
const groupChatModel = () => import('@/app/_authed/(group-chats)/_server/model')

/**
 * Resolve the sender on first use and hold it, so a sender that cannot be
 * named — an unknown or ambiguous agent — refuses every call with the
 * attribution error rather than acting as anyone. `live` is asked before every
 * call: an agent-bound copy stops working once the action that received it has
 * ended, so an extension cannot keep it and speak as that agent later.
 */
function boundSender(resolve: () => Promise<AttributedSender>, live: () => boolean): () => Promise<AttributedSender> {
  let sender: Promise<AttributedSender> | undefined
  return () => {
    if (!live()) {
      return Promise.reject(new Error('This group-chat access was bound to an action call that has ended'))
    }
    sender ??= resolve()
    return sender
  }
}

/**
 * The usage of a thread the extension's own system identity `systemId`
 * opened: numbers from the turn records, and whether a turn is running now.
 * Gated on who OPENED the thread, not on who is sending, so an extension reads
 * the same threads whether an agent, a person or nobody invoked the action.
 */
async function threadUsage(systemId: string, ref: string, since: string | undefined): Promise<HostThreadUsage> {
  const { sessionKey, context } = await (await groupChatModel()).usageSourceForSystem(systemId, ref)
  const from = since === undefined ? undefined : new Date(since)
  if (from && Number.isNaN(from.getTime())) {
    throw new Error(`"since" must be an ISO date; got "${since}"`)
  }
  const turns = await queryChatUsageTurnsBySessionKey(sessionKey, from)
  return {
    turns: turns.map((turn) => ({ ...turn, endedAt: turn.endedAt.toISOString() })),
    busy: agentClient.activeSessionKeys().includes(sessionKey),
    context: context && {
      usedTokens: context.usedTokens,
      contextLimit: context.contextLimit,
      ...(context.asOf === undefined ? {} : { asOf: new Date(context.asOf).toISOString() }),
    },
  }
}

/**
 * Compact a thread the extension's own system identity `systemId` opened, and
 * wait for the job as `group_chat_compact` does: bounded, never stopping the
 * job when the wait gives up.
 */
async function compactOwnThread(systemId: string, ref: string): Promise<HostCompactResult> {
  const watch = await (await groupChatModel()).compactThreadForSystem(systemId, ref)
  const { status } = await waitForCompact(watch, { timeoutMs: COMPACT_WAIT_MS })
  return compactResultOf(status)
}

// Lazy for the same reason as the model, which it imports.
const threadActivity = () => import('@/app/_authed/(group-chats)/_server/thread-activity')

/**
 * The thread-activity calls reading as `reader`: the sender's own chats, or
 * the person's in a copy a person called with. A subscription is held by
 * `binding`, so it ends with the call or the module it was made through.
 */
function threadActivityFor(
  reader: () => Promise<MemberPrincipal>,
  binding: CallBinding,
): Pick<HostGroupChatsApi, 'activity' | 'subscribeActivity'> {
  return {
    activity: async (options) => (await threadActivity()).threadActivityPage(await reader(), options),
    subscribeActivity: (listener) => {
      if (!binding.live()) {
        throw new Error('This group-chat access was bound to an action call that has ended')
      }
      let unsubscribe: (() => void) | null = null
      let released = false
      void threadActivity().then(({ subscribeThreadActivity }) => {
        if (!released) {
          unsubscribe = subscribeThreadActivity(reader, listener)
        }
      })
      return binding.hold(() => {
        released = true
        unsubscribe?.()
      })
    },
  }
}

/** What any sender may do: see its chats, open threads, post, resolve a thread, archive the threads it owns, read the usage of and compact its extension's own threads, and read what its chats' threads are doing. No transcripts. */
function groupChatsForSender(
  who: () => Promise<AttributedSender>,
  systemId: string,
  binding: CallBinding,
): HostGroupChatsApi {
  const withActivity = async (thread: SenderThread) => (await threadActivity()).threadWithActivity(thread)
  return {
    list: async () => (await groupChatModel()).listGroupChatsForSender(await who()),
    startThread: async ({ chat, agentNodeId, message, title, folder, sessionOptions }) => {
      const { startThreadForSender } = await groupChatModel()
      const started = await startThreadForSender(await who(), chat, agentNodeId, message, {
        title,
        folder,
        sessionOptions,
      })
      return { ...started, thread: await withActivity(started.thread) }
    },
    send: async ({ thread, message, queue, sessionOptions }) =>
      (await groupChatModel()).sendInThreadForSender(await who(), thread, message, queue ?? 'wait', sessionOptions),
    thread: async (ref) => withActivity(await (await groupChatModel()).threadForSender(await who(), ref)),
    archive: async (ref) =>
      withActivity(await (await groupChatModel()).setThreadArchivedForSender(await who(), ref, true)),
    unarchive: async (ref) =>
      withActivity(await (await groupChatModel()).setThreadArchivedForSender(await who(), ref, false)),
    usage: async (ref, options) => {
      await who()
      return threadUsage(systemId, ref, options?.since)
    },
    compact: async (ref) => {
      await who()
      return compactOwnThread(systemId, ref)
    },
    ...threadActivityFor(async () => (await who()).principal, binding),
  }
}

/** Who invoked an App action, as the host established it: an agent by name, or a signed-in person. */
export type AppActionCaller = { agent: string } | { person: HostUser }

/**
 * `groupChats` for one App action invocation: the calling agent when an agent
 * called — who may also read, over the chats it belongs to — and the
 * extension's own system identity otherwise, which may not. When a signed-in
 * person called, the extension's identity plus the person's own chats and the
 * grant of that identity into one of them. Built by the host per call and put
 * on the action's context, never chosen by the extension. The caller ends it
 * with `end()` when the action settles.
 */
export function groupChatsForCaller(
  extensionId: string,
  caller: AppActionCaller | undefined,
): { api: HostGroupChatsApi | HostAgentGroupChatsApi | HostPersonGroupChatsApi; end: () => void } {
  let ended = false
  const subscriptions = subscriptionHolder()
  const binding: CallBinding = { live: () => !ended, hold: subscriptions.hold }
  const end = () => {
    ended = true
    subscriptions.end()
  }
  if (!caller) {
    // Nobody to bind the copy to, so it never stops working; its subscriptions still end with the call.
    return {
      api: extensionGroupChats(extensionId, { live: () => true, hold: subscriptions.hold }),
      end: subscriptions.end,
    }
  }
  if ('person' in caller) {
    return { api: personGroupChats(extensionId, caller.person.id, binding), end }
  }
  const who = boundSender(() => senderForSend({ callerAgent: caller.agent }, [], listAgentNodesImpl), binding.live)
  const api: HostAgentGroupChatsApi = {
    ...groupChatsForSender(who, registerExtensionSystemSender(extensionId), binding),
    turns: async (ref, page) => (await groupChatModel()).threadTurnsForSender(await who(), ref, page),
  }
  return { api, end }
}

/**
 * The extension's own identity for sending, and the calls acting as the
 * person: their chats, the grant, and what their chats' threads are doing.
 * The grant names no principal: it can only ever add THIS extension's
 * identity, through the members gate as the person. Like the agent-bound copy,
 * it refuses once the action that received it has ended.
 */
function personGroupChats(extensionId: string, userId: string, binding: CallBinding): HostPersonGroupChatsApi {
  const systemId = registerExtensionSystemSender(extensionId)
  const whilePending = async () => {
    if (!binding.live()) {
      throw new Error('This group-chat access was bound to an action call that has ended')
    }
    return groupChatModel()
  }
  const person = async (): Promise<MemberPrincipal> => {
    await whilePending()
    return { kind: 'user', userId }
  }
  return {
    ...extensionGroupChats(extensionId, binding),
    ...threadActivityFor(person, binding),
    personChats: async () =>
      (await (await whilePending()).listGroupChatsForPerson(userId, systemId)).map(({ systemGranted, ...chat }) => ({
        ...chat,
        extensionGranted: systemGranted,
      })),
    grantExtension: async (chat) => (await whilePending()).grantSystemSenderAsPerson(userId, chat, systemId),
  }
}

// Lazy for the same reason as the model, which it imports.
const usageSummary = () => import('@/app/_authed/(group-chats)/_server/usage-summary')

/** Spend summaries reading as `reader`: over the chats it is a member of. */
function usageApi(reader: () => Promise<MemberPrincipal>): HostUsageApi {
  return {
    summary: async (options) => (await usageSummary()).usageSummary(await reader(), options),
  }
}

/** The extension's own system identity, as a chat member. */
function extensionPrincipal(extensionId: string): MemberPrincipal {
  return { kind: 'system', systemId: registerExtensionSystemSender(extensionId) }
}

/**
 * `usage` for one App action invocation, reading as whoever it is on behalf
 * of: the calling agent or person, else the extension's own system identity.
 * Built by the host per call; the caller ends it with `end()` when the action
 * settles, and a copy kept past that refuses.
 */
export function usageForCaller(
  extensionId: string,
  caller: AppActionCaller | undefined,
): { api: HostUsageApi; end: () => void } {
  let ended = false
  const live = () => !ended
  let reader: () => Promise<MemberPrincipal>
  if (!caller) {
    reader = async () => extensionPrincipal(extensionId)
  } else if ('person' in caller) {
    const userId = caller.person.id
    reader = async () => {
      if (!live()) {
        throw new Error('This usage access was bound to an action call that has ended')
      }
      return { kind: 'user', userId }
    }
  } else {
    const who = boundSender(() => senderForSend({ callerAgent: caller.agent }, [], listAgentNodesImpl), live)
    reader = async () => (await who()).principal
  }
  return {
    api: usageApi(reader),
    end: () => {
      ended = true
    },
  }
}

/** `groupChats` as the extension's own system identity. `binding` holds its subscriptions; its other calls work whenever called. */
function extensionGroupChats(extensionId: string, binding: CallBinding): HostGroupChatsApi {
  const systemId = registerExtensionSystemSender(extensionId)
  return groupChatsForSender(
    boundSender(
      async () => ({ author: systemId, principal: { kind: 'system', systemId } }),
      () => true,
    ),
    systemId,
    binding,
  )
}

export interface ExtensionStorageApi {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

const STORAGE_SETTING_ID = 'extension-storage'

// Every extension's storage lives in this ONE shared settings row (namespaced
// only by a `<extensionId>::` key prefix inside its JSON blob) -- see
// storageApi below. A plain read-then-write against that row loses whichever
// write lands second when two calls interleave: both read the same snapshot,
// and the second write silently discards the first's key.
// `delete`/`clear` have the identical shape and hazard. Closed via the shared
// mutex + version-CAS mechanism in settings-cas.ts (generalised to the
// session store too).
function storageApi(extensionId: string): ExtensionStorageApi {
  const prefix = `${extensionId}::`
  return {
    async get<T>(key: string): Promise<T | null> {
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      return (all[prefix + key] as T | undefined) ?? null
    },
    async set<T>(key: string, value: T): Promise<void> {
      await withSettingLock(STORAGE_SETTING_ID, () =>
        mutateSettingData(STORAGE_SETTING_ID, (all) => ({ ...all, [prefix + key]: value })),
      )
    },
    async delete(key: string): Promise<void> {
      await withSettingLock(STORAGE_SETTING_ID, () =>
        mutateSettingData(STORAGE_SETTING_ID, (all) => {
          const next = { ...all }
          delete next[prefix + key]
          return next
        }),
      )
    },
    async list(): Promise<string[]> {
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      return Object.keys(all)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
    async clear(): Promise<void> {
      await withSettingLock(STORAGE_SETTING_ID, () =>
        mutateSettingData(STORAGE_SETTING_ID, (all) => {
          const next = { ...all }
          for (const k of Object.keys(next)) {
            if (k.startsWith(prefix)) {
              delete next[k]
            }
          }
          return next
        }),
      )
    },
  }
}

/** `@opencroft/server/values`: host-free, served as it is. */
type ValuesModule = typeof values

export interface ExtensionHost extends ValuesModule {
  extensionId: string
  /** Where the host serves this extension: `/api/ext/<extensionId>`. */
  urlBase: string
  /** The URL of a static file under the extension's `assets/` folder. */
  assetUrl: (path: string) => string
  /** The URL of one of the extension's declared HTTP `routes`. */
  routeUrl: (path: string) => string
  /**
   * An instance-relative URL (`urlBase`, `assetUrl(…)`, `routeUrl(…)`) in
   * absolute form, for a link handed outside the instance. There is no
   * instance-origin setting, so the origin is the one `request` arrived on.
   */
  absoluteUrl: (request: Request, url?: string) => string
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
  /** This instance's id (`@opencroft/instance`). */
  readonly instanceId: string
  db: typeof db
  secrets: HostSecretsApi
  /** Text with credentials removed, by the rules node reads use — see `@/server/credential-redactor`. */
  credentialRedactor: typeof credentialRedactor
  settings: { get: typeof hostGetSetting; set: typeof hostSetSetting }
  graph: HostGraphApi
  storage: ExtensionStorageApi
  /** The calling extension's own added App instances (see `provides.apps`), and the directory of every App its system identity may see. */
  apps: HostAppsApi
  /** The spaces this extension's own system identity may see — see `directoryApis`. */
  spaces: HostSpacesApi
  /** Deliver a message through a SendMessage node's own path (session reuse/
   *  create, envelope composition, hidden-by-default registration) — the same
   *  mechanism its `text-in` wiring uses, not a parallel implementation. */
  sendMessage: HostSendMessageApi
  /**
   * Group chats as this extension's own system identity (`system.ext.<dotted extension id>`).
   * An App action gets `ctx.groupChats` instead, bound to its calling agent
   * when an agent called — see `groupChatsForCaller`.
   */
  groupChats: HostGroupChatsApi
  /** Spend summaries as this extension's own system identity. An App action gets `ctx.usage` instead, reading as its caller — see `usageForCaller`. */
  usage: ExtensionServerHost['usage']
  /** The people directory, three fields per account — see `@/app/_server/user-directory`. */
  users: HostUsersApi
  /** The agent directory, three fields per agent — see `listAgentDirectory` — and each agent's presence — see `agent-presence`. */
  agents: HostAgentsApi
  /** Who a markdown text mentions — see `@/app/_server/mentions`. */
  mentions: HostMentionsApi
  /** An agent node's credentials for the MCP endpoint — see the package declaration. */
  mcpTokens: HostMcpTokensApi
  /** An agent's instruction texts — see the package declaration and (agent)/_server/agent-instructions. */
  agentInstructions: ExtensionServerHost['agentInstructions']
  /**
   * Fire-and-forget push to all connected clients; received in extension
   * client code via getStream(extensionId, 'events').
   */
  events: { broadcast: (name: string, payload?: Record<string, unknown>) => void }
  /**
   * Referenced, not copied. `ExtensionServerHost` is the declaration extensions
   * compile against; `createHost` below is checked against this one. Spelling the
   * members out twice made a member added to one and not the other fail only at the
   * far end — an extension's own typecheck, or a call that is undefined at runtime.
   * Pointing at the package's declaration makes that a compile error here instead.
   *
   * Only `terminal` and `collab` are shared this way. The two host interfaces
   * are deliberately different elsewhere, so do not widen this to the whole
   * object without establishing that they agree.
   */
  terminal: ExtensionServerHost['terminal']
  agentRefusalOf: typeof agentRefusalOf
  collab: ExtensionServerHost['collab']
  ssh: {
    keys: HostSshKeysApi
    exec(config: ServerConfig, command: string): Promise<string>
    resolveKey(keyPath: string | undefined, scope: { nodeId: string } | undefined): Promise<string | undefined>
  }
  execContext: {
    /** Dispatch an execution-context event to every target connected to
     *  `sourceHandleId` on `sourceNodeId` (broadcast). Returns the primary
     *  target's result plus every target's outcome — see
     *  `_server/exec-dispatch.ts` for the resolution and fan-out contract. */
    dispatch(
      sourceNodeId: string,
      sourceHandleId: string,
      event: unknown,
      options?: ExecDispatchOptions,
    ): Promise<ExecDispatchSummary>
    callTargets: HostExecContextApi['callTargets']
    callableActions: HostExecContextApi['callableActions']
    call: HostExecContextApi['call']
  }
}

// The host's settings API is backed by the request-free impl, NOT the
// createServerFn endpoints of the same name. Two trust surfaces share those
// four functions: the HTTP endpoint, reachable by any browser with a matching
// Origin and so gated to an administrator; and this host API, reachable only by
// extension code an administrator installed, which is already the boundary. The
// impl also carries no dependency on a request-scoped context, which the
// endpoint's admin check does -- an extension may call these from a Nitro route
// that never establishes one, where reading the request would throw. The `data`
// call shape the endpoints used is preserved so extension code is unchanged.
function hostGetSetting(opts: { data: string }) {
  return getSettingImpl(opts.data)
}

function hostSetSetting(opts: { data: { id: string; data: Record<string, unknown> } }) {
  return setSettingImpl(opts.data)
}

export type HostAppsApi = ExtensionServerHost['apps']

/**
 * The subscriptions made through one copy of the host's APIs, held until the
 * copy's owner ends them: a call when it settles, the loader when it unloads
 * the module evaluation the copy was built for.
 */
export interface SubscriptionHolder {
  /** Hold `unsubscribe` until `end`; returns the unsubscribe to hand the extension, which also lets go of it. */
  hold: (unsubscribe: () => void) => () => void
  /** End every subscription still held. One held after this ends at once. */
  end: () => void
}

export function subscriptionHolder(): SubscriptionHolder {
  let ended = false
  const held = new Set<() => void>()
  return {
    hold: (unsubscribe) => {
      if (ended) {
        unsubscribe()
        return () => {}
      }
      const release = () => {
        held.delete(release)
        unsubscribe()
      }
      held.add(release)
      return release
    },
    end: () => {
      ended = true
      for (const release of [...held]) {
        release()
      }
    },
  }
}

/** What binds a directory copy to one call: whether the call is still running, and what holds its subscriptions. */
interface CallBinding {
  live: () => boolean
  hold: SubscriptionHolder['hold']
}

/**
 * `spaces` and `apps` seeing as `viewer`. A copy bound to one caller stops
 * working once that call has ended, and the subscriptions made through it end
 * with the call.
 */
function directoryApis(
  extensionId: string,
  viewer: DirectoryViewer,
  binding: CallBinding,
): { spaces: HostSpacesApi; apps: HostAppsApi } {
  const whileLive = () => {
    if (!binding.live()) {
      throw new Error('This directory access was bound to a call that has ended')
    }
  }
  const subscribeTo = (listing: DirectoryListing) => (listener: Parameters<HostSpacesApi['subscribe']>[0]) => {
    whileLive()
    return binding.hold(subscribeDirectoryListing(listing, listener))
  }
  return {
    spaces: {
      list: async () => {
        whileLive()
        return listSpacesFor(viewer)
      },
      subscribe: subscribeTo('spaces'),
    },
    apps: {
      ...appsApi(extensionId),
      directory: async (options) => {
        whileLive()
        return appDirectoryFor(viewer, options)
      },
      subscribe: subscribeTo('apps'),
    },
  }
}

/**
 * `spaces` and `apps` for one call on behalf of `caller` — an App action, a
 * session route — or as the extension's own system identity when nobody is
 * named. Built by the host per call, never chosen by the extension; the caller
 * ends it with `end()` when the call settles.
 */
export function directoryForCaller(
  extensionId: string,
  caller: AppActionCaller | undefined,
): { spaces: HostSpacesApi; apps: HostAppsApi; end: () => void } {
  let ended = false
  const subscriptions = subscriptionHolder()
  const viewer: DirectoryViewer = !caller
    ? { kind: 'system', systemId: registerExtensionSystemSender(extensionId) }
    : 'person' in caller
      ? { kind: 'person', userId: caller.person.id }
      : { kind: 'agent', name: caller.agent }
  return {
    ...directoryApis(extensionId, viewer, { live: () => !ended, hold: subscriptions.hold }),
    end: () => {
      ended = true
      subscriptions.end()
    },
  }
}

// Read from the database rather than the (apps) runtime's in-memory load
// state: an extension server module can be re-evaluated at any time (source
// edit, rebuild), and this answer must not depend on which process events it
// happened to witness.
function appsApi(extensionId: string): Pick<HostAppsApi, 'listInstances'> {
  return {
    listInstances: async (type) => {
      const wanted = type ? resolveTypeRef(extensionId, type) : undefined
      const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
      const spaces = await db.query.space.findMany({ columns: { id: true, slug: true } })
      const slugById = new Map(spaces.map((s) => [s.id, s.slug]))
      return rows.flatMap((row) => {
        const parsed = parseType(row.type)
        if (parsed?.extensionId !== extensionId || (wanted && row.type !== wanted)) {
          return []
        }
        return [
          {
            instanceId: row.id,
            type: parsed.bare,
            appSlug: parsed.bare,
            spaceSlug: slugById.get(row.spaceId) ?? '',
            name: row.name,
            slug: row.slug,
            params: JSON.parse(row.params) as Record<string, string>,
            dataDir: appInstanceDataDir(extensionId, row.id),
          },
        ]
      })
    },
  }
}

/**
 * The host one evaluation of an extension's server module sees. `hold` keeps
 * the subscriptions made through it; the loader passes one it ends when it
 * unloads that evaluation, so a listener the module never removed does not
 * outlive it.
 */
export function createHost(
  extensionId: string,
  hold: SubscriptionHolder['hold'] = subscriptionHolder().hold,
): ExtensionHost {
  const urlBase = extensionUrlBase(extensionId)
  return {
    ...values,
    extensionId,
    urlBase,
    assetUrl: (path) => extensionUrl(extensionId, 'assets', path),
    routeUrl: (path) => extensionUrl(extensionId, 'http', path),
    absoluteUrl: (request, url = urlBase) => new URL(url, request.url).href,
    fs: fsPromises,
    os: nodeOs,
    path: nodePath,
    exec,
    execFile: execFilePromise,
    cacheDir: (...parts) => cacheDir('extensions', extensionId, ...parts),
    dataDir: (...parts) => dataDir('extension-data', extensionId, ...parts),
    crypto: { encrypt, decrypt, randomToken, randomString },
    // Read when an extension loads it, not when a host is built: the first read writes the file.
    get instanceId() {
      return instanceId()
    },
    db,
    secrets,
    credentialRedactor,
    settings: { get: hostGetSetting, set: hostSetSetting },
    graph: graphApiFor(extensionId),
    storage: storageApi(extensionId),
    ...directoryApis(
      extensionId,
      { kind: 'system', systemId: registerExtensionSystemSender(extensionId) },
      { live: () => true, hold },
    ),
    sendMessage: sendMessageApi,
    groupChats: extensionGroupChats(extensionId, { live: () => true, hold }),
    usage: usageApi(async () => extensionPrincipal(extensionId)),
    users: { list: listUserDirectory },
    agents: {
      list: listAgentDirectory,
      presence: listAgentPresence,
      subscribePresence: (listener) => hold(subscribeAgentPresence(listener)),
    },
    mentions: { find: mentionsIn },
    mcpTokens: mcpTokensApi,
    agentInstructions: {
      read: readAgentInstructions,
      write: (id, role, text, options) => writeAgentInstructions(id, role, text, { expected: options?.expected }),
    },
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
      startJob: startJobSession,
      stopViewJob,
      readFile: readTerminalFile,
      writeFile: writeTerminalFile,
      listFolders: listTerminalFolders,
      spawn: (ctx, argv, opts) => getBackend(ctx).spawn(ctx, argv, opts),
    },
    agentRefusalOf,
    // `scope` is read optionally: an extension compiled against an older `@opencroft/server` calls
    // without one, and a Key Store reference is then refused by the host's check rather than read.
    ssh: { keys: sshKeys, exec: sshExec, resolveKey: (keyPath, scope) => resolveKeyContent(keyPath, scope?.nodeId) },
    execContext: {
      dispatch: dispatchExecutionContextForHost,
      callTargets: graphCallTargets,
      callableActions: graphCallActions,
      call: callFromGraph,
    },
    collab: collabApiFor(extensionId),
  }
}
