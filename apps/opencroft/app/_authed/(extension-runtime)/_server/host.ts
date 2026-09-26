import { execFile } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'

import { db, spaceApp } from '@opencroft/db'
import type {
  ExtensionServerHost,
  HostAgentGroupChatsApi,
  HostMcpTokensApi,
  HostPersonGroupChatsApi,
  HostSecretsApi,
  HostThreadUsage,
  HostUser,
  HostUsersApi,
} from '@opencroft/server'
import type { ServerConfig, TerminalContext } from '@opencroft/terminal'
import {
  exec,
  resolveKeyContent,
  sshExec,
  startJobSession,
  terminalExec,
  terminalExecResult,
  terminalRun,
  terminalRunResult,
} from '@opencroft/terminal/server'
import { foldEvents, isSnapshotEvent } from 'agent-client/fold'
import type { ChatEvent } from 'agent-client/types'
import { asc, eq } from 'drizzle-orm'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { queryChatUsageTurnsBySessionKey } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { sessionActivitySets } from '@/app/_authed/(agent)/_server/session-activity'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import {
  dispatchExecutionContext,
  type ExecDispatchSummary,
} from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import {
  deliverToSendMessageNode,
  type SendMessageDeliveryResult,
  type GraphEdgeLike as SendMessageEdgeLike,
  type GraphNodeLike as SendMessageNodeLike,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { mcpTokensApi } from '@/app/_authed/(mcp)/_server/mcp-tokens'
import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl, setSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { type AttributedSender, registerExtensionSystemSender, senderForSend } from '@/app/_server/message-author'
import { listUserDirectory } from '@/app/_server/user-directory'
import { newGraphId } from '@/lib/graph-id'
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

// One entry per GRAPH, not per space: nodes live on graphs now, and anything
// enumerating them has to see every canvas of every space.
interface GraphEntry {
  /** The graph's address (`<space>.<graph>`) -- what saveGraph takes. */
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

async function readGraph(): Promise<GraphSnapshot> {
  const graphs = await loadAllGraphs()
  const nodes: GraphNodeRecord[] = []
  const edges: GraphEdgeRecord[] = []
  for (const g of graphs) {
    nodes.push(...(g.graph.nodes as unknown as GraphNodeRecord[]))
    edges.push(...(g.graph.edges as unknown as GraphEdgeRecord[]))
  }
  return { nodes, edges }
}

async function writeNodePatch(nodeId: string, mutate: (graph: GraphData) => boolean): Promise<void> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const ref = r.findByNode(nodeId)
  if (!ref) {
    return
  }
  if (mutate(ref.graph.graph)) {
    await r.saveGraph(r.addressOf(ref), ref.graph.graph)
  }
}

export interface HandleInfo {
  nodeId: string
  // listNodes flattens spaces; handle discovery doesn't, because a picker has
  // to be able to say which space a source came from.
  spaceSlug: string
  typeId: string
  // node.data.name, falling back to the type id — for pickers.
  nodeName: string
  // The live id, resolvable by terminal.getContext. For a dynamic handle this
  // is the expanded runtime id, not the declared prefix.
  handleId: string
  // The manifest id — the prefix form for a dynamic handle.
  declaredId: string
  contextType: string
  role: 'source' | 'target'
  label?: string
  dynamic: boolean
}

export interface ListHandlesFilter {
  role?: 'source' | 'target'
  contextType?: string
}

export interface HostGraphApi {
  listNodes(): Promise<GraphNodeRecord[]>
  getNode(nodeId: string): Promise<GraphNodeRecord | null>
  listNodesByType(typeId: string): Promise<GraphNodeRecord[]>
  listEdges(): Promise<GraphEdgeRecord[]>
  // Every handle declared by a node type, across all spaces, with dynamic
  // source handles expanded to their live ids. Read-on-demand and uncached:
  // expansion asks each application node's docker context what is running, so
  // the result is only true at the moment it is produced.
  listHandles(filter?: ListHandlesFilter): Promise<HandleInfo[]>
  updateNode(nodeId: string, patch: Partial<GraphNodeRecord>): Promise<GraphNodeRecord | null>
  /** On the graph at `address` — a space slug (its default graph) or `<space>.<graph>`. */
  createNode(
    address: string,
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
    const r = getSpacesRegistry()
    await r.ensureLoaded()
    const ref = r.findByNode(nodeId)
    const node = ref?.graph.graph.nodes.find((n) => (n as { id?: string }).id === nodeId)
    return (node as unknown as GraphNodeRecord) ?? null
  },
  async listNodesByType(typeId) {
    const graph = await readGraph()
    return graph.nodes.filter((n) => n.type === typeId)
  },
  async listEdges() {
    return (await readGraph()).edges
  },
  async listHandles(filter) {
    // Lazy imports for the same reason getTerminalContext uses them: loader.ts
    // imports this module, so a static edge back to it would close a cycle.
    // Same manifest source as getTerminalContext, so a handle this returns is
    // one that resolver can actually resolve.
    const { listExtensionManifestsImpl } = await import(
      '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
    )
    const { buildNodeTypeHandles, expandDynamicHandles, findDockerExtensionId } = await import(
      '@/app/_authed/(extension-runtime)/_server/node-handles'
    )
    const [graphs, manifests] = await Promise.all([loadAllGraphs(), listExtensionManifestsImpl()])
    const byType = buildNodeTypeHandles(manifests)
    const dockerExtensionId = findDockerExtensionId(manifests)
    const wanted = (handle: { role: string; contextType: string }) =>
      (filter?.role === undefined || handle.role === filter.role) &&
      (filter?.contextType === undefined || handle.contextType === filter.contextType)

    const results: HandleInfo[] = []
    for (const entry of graphs) {
      for (const raw of entry.graph.nodes as unknown as GraphNodeRecord[]) {
        const typeId = raw.type
        if (!typeId) {
          continue
        }
        const declared = byType.get(typeId)?.handles ?? []
        const nodeName = (raw.data?.name as string) || typeId
        const base = { nodeId: raw.id, spaceSlug: entry.spaceSlug, typeId, nodeName }

        const matching = declared.filter(wanted)
        // Expansion costs a docker.ps per node, so do it once and only when a
        // dynamic handle actually survived the filter — a caller asking for
        // targets, or for some other contextType, pays nothing.
        const liveIds = matching.some((handle) => handle.dynamic)
          ? await expandDynamicHandles(raw, declared, dockerExtensionId)
          : []

        for (const handle of matching) {
          if (!handle.dynamic) {
            results.push({
              ...base,
              handleId: handle.id,
              declaredId: handle.id,
              contextType: handle.contextType,
              role: handle.role,
              label: handle.label,
              dynamic: false,
            })
            continue
          }
          // A dynamic handle's declared id is only a prefix — emit one entry
          // per live id instead, so every handleId returned is one that
          // terminal.getContext can actually resolve.
          for (const liveId of liveIds.filter((id) => id.startsWith(handle.id))) {
            results.push({
              ...base,
              handleId: liveId,
              declaredId: handle.id,
              contextType: handle.contextType,
              role: handle.role,
              label: handle.label,
              dynamic: true,
            })
          }
        }
      }
    }
    // App instances expose handles too (addressed as <instanceId>/<handleId>),
    // and only as sources — an App consumes contexts through its parameters.
    if (filter?.role === undefined || filter.role === 'source') {
      const { listAppHandles } = await import('@/app/_authed/(apps)/_server/runtime')
      for (const handle of await listAppHandles(filter?.contextType)) {
        results.push({
          nodeId: handle.instanceId,
          spaceSlug: handle.spaceSlug,
          typeId: `app:${handle.appSlug}`,
          nodeName: handle.title,
          handleId: handle.handleId,
          declaredId: handle.declaredId,
          contextType: handle.contextType,
          role: 'source',
          label: handle.label,
          dynamic: handle.dynamic,
        })
      }
    }
    return results
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
  async createNode(address, typeId, data, position) {
    const r = getSpacesRegistry()
    await r.ensureLoaded()
    const ref = r.resolveGraph(address)
    if (!ref) {
      throw new Error(`Graph not found: ${address}`)
    }
    const id = newGraphId()
    const node: GraphNodeRecord = { id, type: typeId, data, position }
    ref.graph.graph.nodes.push(node as unknown as Record<string, unknown>)
    await r.saveGraph(r.addressOf(ref), ref.graph.graph)
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

// The same enumeration the per-extension host hands to server modules, exported
// for the app's own callers (the terminal-target picker's server fn) — one
// discovery, not a second implementation of it.
export function listGraphHandles(filter?: ListHandlesFilter): Promise<HandleInfo[]> {
  return graphApi.listHandles(filter)
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
    edges: graphs.flatMap((g) => g.graph.edges) as unknown as SendMessageEdgeLike[],
  }
}

export interface TurnSummary {
  index: number
  prompt: string
  promptLength: number
  // 'unknown' is a replayed turn: it ended — a later prompt proves it — but a
  // session/load replay does not say how, so neither does this.
  status: 'finished' | 'in-progress' | 'interrupted' | 'unknown'
  finalMessage?: string
  finalMessageLength?: number
}

export interface TurnsPage {
  turns: TurnSummary[]
  hasMore: boolean
  nextBeforeIndex: number | null
  // The session's own status (see deriveSessionStatus). An empty `turns`
  // array means two different things depending on this: a genuinely empty
  // (never-prompted) session at idle/working/waiting, vs. an offline session
  // whose history isn't loaded in memory at all — a caller must be able to
  // tell them apart without having read this action's description.
  sessionStatus: SessionStatus
}

// ~400 chars is enough to identify a turn at a glance without pulling its
// full text into an agent's context — these actions must stay cheap to call
// regardless of how long a session's transcript is.
const TURN_TEXT_MAX_CHARS = 400
const DEFAULT_TURNS = 10
// `turns` is caller-controlled — an unbounded value would walk the whole
// transcript and scale the response with it, defeating the point of keeping
// each turn's text truncated.
const MAX_TURNS = 50

// The turn-paging core shared by every surface that lists a session's turns:
// the send-message node's listTurns action below, and the group-chat
// group_chat_turns tool (model.ts) — same window, same summaries, same paging,
// so a turn reads identically wherever it is inspected from. Callers own their
// authorization (graph reachability there, thread membership here); this
// function only answers for a session key it is already allowed to see.
export function turnsPageForSessionKey(
  sessionKey: string,
  params: { turns?: number; beforeIndex?: number },
): TurnsPage {
  const turns = params.turns && params.turns > 0 ? Math.min(Math.floor(params.turns), MAX_TURNS) : DEFAULT_TURNS
  const sessionStatus = deriveSessionStatus(sessionKey, sessionActivitySets())
  const meta = agentClient.listSessions().find((m) => m.sessionKey === sessionKey)
  if (!meta) {
    // No live process for this session (dead, or never started) — nothing
    // in memory to page through.
    return { turns: [], hasMore: false, nextBeforeIndex: null, sessionStatus }
  }
  const window = agentClient.getEventsWindow(meta.id, { turns, beforeIndex: params.beforeIndex })
  if (!window) {
    return { turns: [], hasMore: false, nextBeforeIndex: null, sessionStatus }
  }
  // Only the tail window (no beforeIndex) can end on the session's current,
  // still-running turn — any older page is by definition already over.
  const tailInProgress = params.beforeIndex === undefined && agentClient.hasActiveTurn(meta.id)
  const groups = splitIntoTurns(window.events, window.startIndex)
  return {
    turns: groups.map((group, i) =>
      buildTurnSummary(group.index, group.events, tailInProgress && i === groups.length - 1),
    ),
    hasMore: window.hasMore,
    nextBeforeIndex: window.hasMore ? window.startIndex : null,
    sessionStatus,
  }
}

export function truncateText(text: string, max = TURN_TEXT_MAX_CHARS): { text: string; length: number } {
  const length = text.length
  return length <= max ? { text, length } : { text: `${text.slice(0, max)}… [truncated]`, length }
}

export function turnStatus(events: ChatEvent[], inProgress: boolean): TurnSummary['status'] {
  if (inProgress) {
    return 'in-progress'
  }
  const end = events.find((e) => e.kind === 'turn_end')
  if (!end || end.kind !== 'turn_end') {
    // No terminal event at all: the turn errored (settleTurn's failure path
    // never emits turn_end) or the process died mid-turn — either way, cut
    // off rather than completed.
    return 'interrupted'
  }
  // 'replayed' = a synthetic boundary loadSession reconstructs between two
  // replayed turns. It says the turn ended — the prompt that follows proves
  // that — and nothing about how, because the replay carries no stopReason.
  // Reporting these as finished would claim an outcome never observed; as
  // interrupted, it would claim a failure that never happened.
  if (end.stopReason === 'replayed') {
    return 'unknown'
  }
  // 'cancelled' = force-interrupted (stopProcessLocal/force-send); 'resumed'
  // = a synthetic marker loadSession emits for the LAST replayed turn, the one
  // a restart could have cut off mid-flight (see agent-client.ts) — both are
  // incomplete, not finished.
  return end.stopReason === 'cancelled' || end.stopReason === 'resumed' ? 'interrupted' : 'finished'
}

// The prompt that opened a turn, joined back together. A message is a run of
// 'user' events (one per content delta), and splitIntoTurns puts that whole run
// at the head of the group — so the prompt is the leading run, not its first
// event. Reading one event would report a fragment as the whole question.
function openingPrompt(events: ChatEvent[]): string {
  let text = ''
  for (const event of events) {
    // Snapshots are not part of the message and can interleave with its chunks,
    // so they neither contribute text nor end the run.
    if (isSnapshotEvent(event)) {
      continue
    }
    if (event.kind !== 'user') {
      break
    }
    text += event.text
  }
  return text
}

export function buildTurnSummary(index: number, events: ChatEvent[], inProgress: boolean): TurnSummary {
  const prompt = truncateText(openingPrompt(events))
  const status = turnStatus(events, inProgress)
  const summary: TurnSummary = { index, prompt: prompt.text, promptLength: prompt.length, status }
  // 'unknown' carries its final message too: a replayed turn's reply was
  // recorded in full and only its ENDING went unobserved. Withholding text that
  // is right there would make listTurns least useful on exactly the sessions
  // this status exists for. 'in-progress' and 'interrupted' still omit it —
  // there the text really is partial.
  if (status === 'finished' || status === 'unknown') {
    // `agent_message` is a streaming chunk, not a whole message: one is emitted
    // per content delta, so a reply arrives as a run of them. Fold the events
    // back into messages — the same concatenation the chat view renders from —
    // and take the last assistant message. Reading the last event on its own
    // would report only that message's trailing fragment.
    const assistantMessages = foldEvents(events).filter((message) => message.kind === 'assistant')
    const final = truncateText(assistantMessages.at(-1)?.text ?? '')
    summary.finalMessage = final.text
    summary.finalMessageLength = final.length
  }
  return summary
}

// Split a window's flat event array back into per-turn groups, tagging each
// with its absolute index (window.startIndex + offset) so it can double as
// the next page's `beforeIndex` cursor. tailByTurns/pageBeforeByTurns cut at
// 'user' boundaries when any exist, but a session with zero turns (created,
// never prompted — only 'modes'/'config_options'/etc. snapshot events) has
// none: tailByTurns then returns that whole snapshot-only log as-is, not
// starting with 'user'. Those leading events aren't part of any turn — skip
// them (nothing to attach them to) rather than assume the invariant holds.
export function splitIntoTurns(events: ChatEvent[], startIndex: number): { index: number; events: ChatEvent[] }[] {
  const groups: { index: number; events: ChatEvent[] }[] = []
  // The kind of the last event that was part of the conversation. Snapshots
  // carry session state and can land anywhere, including between two chunks of
  // one message, so they belong to whichever turn is open but must not decide
  // where a turn begins — tracked separately rather than read off the previous
  // index for exactly that reason.
  let previousKind: ChatEvent['kind'] | undefined
  events.forEach((event, offset) => {
    if (isSnapshotEvent(event)) {
      if (groups.length > 0) {
        groups[groups.length - 1].events.push(event)
      }
      return
    }
    if (event.kind === 'user') {
      // A prompt arrives as a RUN of 'user' events — one per content delta, the
      // same way a reply does — so only the FIRST of a run opens a turn. Opening
      // one per event splits a chunked message into several turns, the leading
      // ones holding a fragment and no terminal event, which then read as cut
      // off. A run that starts the window has no predecessor to check and opens
      // a turn: a window cut cannot tell a continuation from a beginning.
      if (previousKind === 'user' && groups.length > 0) {
        groups[groups.length - 1].events.push(event)
      } else {
        groups.push({ index: startIndex + offset, events: [event] })
      }
    } else if (groups.length > 0) {
      groups[groups.length - 1].events.push(event)
    }
    previousKind = event.kind
  })
  return groups
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
    if (!found || found.node.type !== 'send-message') {
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
  const manifest = manifests.find((m) => m.nodes?.some((n) => n.typeId === node.type))
  if (!manifest) {
    throw new Error(`No extension provides node type: ${node.type}`)
  }
  const { getExtensionModule } = await import('@/app/_authed/(extension-runtime)/_server/loader')
  const mod = await getExtensionModule(manifest.id)
  const value = mod.exposeOutput?.(handleId, node.data, node.type)
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

/**
 * Group chats as seen by ONE sender the host has already decided: the agent
 * that invoked an App action, or the extension's own system identity. The
 * extension never names who it speaks as — see `groupChatsForCaller` — so it
 * cannot speak as an agent that did not call it.
 */
export type HostGroupChatsApi = ExtensionServerHost['groupChats']
export type { HostAgentGroupChatsApi }

// Lazy: the group-chat model imports this module (turnsPageForSessionKey), so a
// static import here would be a cycle.
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
  const sessionKey = await (await groupChatModel()).usageSessionKeyForSystem(systemId, ref)
  const from = since === undefined ? undefined : new Date(since)
  if (from && Number.isNaN(from.getTime())) {
    throw new Error(`"since" must be an ISO date; got "${since}"`)
  }
  const turns = await queryChatUsageTurnsBySessionKey(sessionKey, from)
  return {
    turns: turns.map((turn) => ({ ...turn, endedAt: turn.endedAt.toISOString() })),
    busy: agentClient.activeSessionKeys().includes(sessionKey),
  }
}

/** What any sender may do: see its chats, open threads, post, resolve a thread, read the usage of its extension's own threads. No transcripts. */
function groupChatsForSender(who: () => Promise<AttributedSender>, systemId: string): HostGroupChatsApi {
  return {
    list: async () => (await groupChatModel()).listGroupChatsForSender(await who()),
    startThread: async ({ chat, agentNodeId, message, title, folder }) => {
      const { startThreadForSender } = await groupChatModel()
      return startThreadForSender(await who(), chat, agentNodeId, message, { title, folder })
    },
    send: async ({ thread, message, queue }) =>
      (await groupChatModel()).sendInThreadForSender(await who(), thread, message, queue ?? 'wait'),
    thread: async (ref) => (await groupChatModel()).threadForSender(await who(), ref),
    usage: async (ref, options) => {
      await who()
      return threadUsage(systemId, ref, options?.since)
    },
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
  if (!caller) {
    return { api: extensionGroupChats(extensionId), end: () => {} }
  }
  let ended = false
  const live = () => !ended
  const end = () => {
    ended = true
  }
  if ('person' in caller) {
    return { api: personGroupChats(extensionId, caller.person.id, live), end }
  }
  const who = boundSender(() => senderForSend({ callerAgent: caller.agent }, [], listAgentNodesImpl), live)
  const api: HostAgentGroupChatsApi = {
    ...groupChatsForSender(who, registerExtensionSystemSender(extensionId)),
    turns: async (ref, page) => (await groupChatModel()).threadTurnsForSender(await who(), ref, page),
  }
  return { api, end }
}

/**
 * The extension's own identity for sending, and two calls acting as the
 * person. The grant names no principal: it can only ever add THIS extension's
 * identity, through the members gate as the person. Like the agent-bound copy,
 * it refuses once the action that received it has ended.
 */
function personGroupChats(extensionId: string, userId: string, live: () => boolean): HostPersonGroupChatsApi {
  const systemId = registerExtensionSystemSender(extensionId)
  const whilePending = async () => {
    if (!live()) {
      throw new Error('This group-chat access was bound to an action call that has ended')
    }
    return groupChatModel()
  }
  return {
    ...extensionGroupChats(extensionId),
    personChats: async () =>
      (await (await whilePending()).listGroupChatsForPerson(userId, systemId)).map(({ systemGranted, ...chat }) => ({
        ...chat,
        extensionGranted: systemGranted,
      })),
    grantExtension: async (chat) => (await whilePending()).grantSystemSenderAsPerson(userId, chat, systemId),
  }
}

function extensionGroupChats(extensionId: string): HostGroupChatsApi {
  const systemId = registerExtensionSystemSender(extensionId)
  return groupChatsForSender(
    boundSender(
      async () => ({ author: systemId, principal: { kind: 'system', systemId } }),
      () => true,
    ),
    systemId,
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
  settings: { get: typeof hostGetSetting; set: typeof hostSetSetting }
  graph: HostGraphApi
  storage: ExtensionStorageApi
  /** The calling extension's own added App instances (see `provides.apps`). */
  apps: HostAppsApi
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
  /** The people directory, three fields per account — see `@/app/_server/user-directory`. */
  users: HostUsersApi
  /** An agent node's credentials for the MCP endpoint — see the package declaration. */
  mcpTokens: HostMcpTokensApi
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
   * Only `terminal` is shared this way. The two host interfaces are deliberately
   * different elsewhere, so do not widen this to the whole object without
   * establishing that they agree.
   */
  terminal: ExtensionServerHost['terminal']
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

/** One added App instance, as reported to the providing extension. */
export interface HostAppInstance {
  instanceId: string
  appSlug: string
  spaceSlug: string
  /** The instance's display name — the host's field, required at add time. */
  name: string
  /** The instance's slug — unique in its space; `<spaceSlug>.<slug>` is its address. */
  slug: string
  params: Record<string, string>
  /** Absolute path of the instance's private data directory. */
  dataDir: string
}

export interface HostAppsApi {
  /** The calling extension's added App instances, oldest first; optionally one App's only. */
  listInstances(appSlug?: string): Promise<HostAppInstance[]>
}

// Read from the database rather than the (apps) runtime's in-memory load
// state: an extension server module can be re-evaluated at any time (source
// edit, rebuild), and this answer must not depend on which process events it
// happened to witness.
function appsApi(extensionId: string): HostAppsApi {
  return {
    listInstances: async (appSlug) => {
      const rows = await db.query.spaceApp.findMany({
        where: eq(spaceApp.extensionId, extensionId),
        orderBy: asc(spaceApp.createdAt),
      })
      const spaces = await db.query.space.findMany({ columns: { id: true, slug: true } })
      const slugById = new Map(spaces.map((s) => [s.id, s.slug]))
      return rows
        .filter((row) => !appSlug || row.appSlug === appSlug)
        .map((row) => ({
          instanceId: row.id,
          appSlug: row.appSlug,
          spaceSlug: slugById.get(row.spaceId) ?? '',
          name: row.name,
          slug: row.slug,
          params: JSON.parse(row.params) as Record<string, string>,
          dataDir: appInstanceDataDir(extensionId, row.id),
        }))
    },
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
    settings: { get: hostGetSetting, set: hostSetSetting },
    graph: graphApi,
    storage: storageApi(extensionId),
    apps: appsApi(extensionId),
    sendMessage: sendMessageApi,
    groupChats: extensionGroupChats(extensionId),
    users: { list: listUserDirectory },
    mcpTokens: mcpTokensApi,
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
    },
    ssh: { exec: sshExec, resolveKey: resolveKeyContent },
    execContext: { dispatch: dispatchExecutionContextForHost },
  }
}
