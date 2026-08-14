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
import { foldEvents, isSnapshotEvent } from 'agent-client/fold'
import type { ChatEvent } from 'agent-client/types'

import { forgetLocalSessionImpl, stopLocalSessionProcessImpl } from '@/app/_authed/(agent)/_server/acp-impl'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { deleteSession as deleteSessionEntry, readSessions } from '@/app/_authed/(agent)/_server/agent-sessions-store'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import {
  dispatchExecutionContext,
  type ExecDispatchSummary,
} from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import {
  parseSessionKey,
  reachableAgentJobs,
  reachablePairKey,
  reachablePairs,
} from '@/app/_authed/(extension-runtime)/_server/send-message-helpers'
import { type ContextUsage, toContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import {
  type CompactAck,
  type CompactStatus,
  deliverToSendMessageNode,
  getCompactStatusOnGraph,
  requestCompactOnGraph,
  type SendMessageDeliveryResult,
  type GraphEdgeLike as SendMessageEdgeLike,
  type GraphNodeLike as SendMessageNodeLike,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { getSetting, setSetting } from '@/app/_authed/(settings)/_server/actions'
import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
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
    const [spaces, manifests] = await Promise.all([loadAllSpaces(), listExtensionManifestsImpl()])
    const byType = buildNodeTypeHandles(manifests)
    const dockerExtensionId = findDockerExtensionId(manifests)
    const wanted = (handle: { role: string; contextType: string }) =>
      (filter?.role === undefined || handle.role === filter.role) &&
      (filter?.contextType === undefined || handle.contextType === filter.contextType)

    const results: HandleInfo[] = []
    for (const space of spaces) {
      for (const raw of space.graph.nodes as unknown as GraphNodeRecord[]) {
        const typeId = raw.type
        if (!typeId) {
          continue
        }
        const declared = byType.get(typeId)?.handles ?? []
        const nodeName = (raw.data?.name as string) || typeId
        const base = { nodeId: raw.id, spaceSlug: space.slug, typeId, nodeName }

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

// The agent/job slug pairs a send-message node can route to, and the graph
// wiring behind group-chat thread reachability, live in
// send-message-helpers.ts — imported above — so listSessions/listTurns
// filtering the (node-independent) persisted session registry, and a thread
// send's reachability check, both read the SAME authority, not a copy of it.

export interface SessionSummary {
  sessionKey: string
  agent: string
  job: string
  title: string
  createdAt: number
  lastActivityAt: number
  // Same four-state vocabulary and derivation as the chat list's row status
  // (see deriveSessionStatus) — waiting (pending permission) > working
  // (active turn) > idle (alive, neither) > offline (no process).
  status: SessionStatus
  // How much context the session is holding, as last reported by its own
  // harness — never estimated here.
  //
  // `null` means UNKNOWN, and a caller must not read it as "nothing held".
  // Three different things produce it: an `offline` session (no live process
  // to have reported anything), a session that has not completed a turn since
  // it was loaded, and a harness that does not report usage at all.
  //
  // `contextLimit` is null on its own when the harness reports usage but
  // cannot say what the model's window is; a caller wanting a ratio needs both
  // and should treat a null limit as "cannot compute one".
  contextUsage: ContextUsage | null
  // Server-held prompts waiting for the session's current turn to end. Unlike
  // `contextUsage`, 0 is a fact, not unknown — an offline/unloaded session
  // cannot hold server-side prompts.
  queuedMessages: number
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
  // The session's own status (see SessionSummary.status). An empty `turns`
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
  const sessionStatus = deriveSessionStatus(sessionKey, {
    pending: new Set(agentClient.pendingPermissionSessionKeys()),
    active: new Set(agentClient.activeSessionKeys()),
    alive: new Set(agentClient.aliveSessionKeys()),
  })
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
  send(nodeId: string, payload: Record<string, unknown>): Promise<SendMessageDeliveryResult>
  listAgents(nodeId: string): Promise<{ agent: string; jobs: string[] }[]>
  listSessions(nodeId: string, params: { agent?: string; job?: string }): Promise<SessionSummary[]>
  listTurns(nodeId: string, params: { sessionKey: string; turns?: number; beforeIndex?: number }): Promise<TurnsPage>
  compact(nodeId: string, params: { sessionKey: string }): Promise<CompactAck>
  compactStatus(nodeId: string, params: { sessionKey: string }): Promise<CompactStatus>
  /** Terminates an idle session's process; the transcript and durable session pointer are kept, so the next message reloads it transparently (same cold-start resume an offline session already uses). */
  unload(nodeId: string, params: { sessionKey: string }): Promise<{ sessionKey: string; unloaded: true }>
  /**
   * Removes a session for good: drops its durable session pointer (and any
   * config overrides) AND its chat-list entry, so it no longer resumes and no
   * longer appears in the sidebar. Default requires `status` (see
   * listSessions) to be `offline` -- deleting a live session would silently
   * drop whatever it's doing, so `idle`/`working`/`waiting` are refused unless
   * `force: true`, which first ends the live process (same teardown as a live
   * chat delete) and then proceeds. The underlying harness's on-disk
   * transcript is deliberately left alone and NOT located or deleted -- this
   * stays harness-agnostic, the same boundary agentClient.loadSession
   * observes, and the harness may be running on a different terminal context
   * (local/WSL/SSH) than this server; the transcript is orphaned, not lost
   * track of.
   */
  delete(
    nodeId: string,
    params: { sessionKey: string; force?: boolean },
  ): Promise<{ sessionKey: string; deleted: true }>
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
      throw new Error(
        'No agent/job resolved for this message — check the agent/job slugs (or this node’s own defaults) against listAgents',
      )
    }
    return result
  },
  async listAgents(nodeId) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    return reachableAgentJobs(found.nodes, found.edges)
  },

  async listSessions(nodeId, params) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const reachable = reachablePairs(found.nodes, found.edges)
    const agentFilter = typeof params.agent === 'string' ? params.agent.trim() : undefined
    const jobFilter = typeof params.job === 'string' ? params.job.trim() : undefined

    const sessionKeys = {
      pending: new Set(agentClient.pendingPermissionSessionKeys()),
      active: new Set(agentClient.activeSessionKeys()),
      alive: new Set(agentClient.aliveSessionKeys()),
    }
    const metaByKey = new Map(
      agentClient
        .listSessions()
        .filter((m) => m.sessionKey)
        .map((m) => [m.sessionKey as string, m]),
    )

    const out: SessionSummary[] = []
    for (const entry of await readSessions()) {
      const parts = parseSessionKey(entry.key)
      if (!parts || !reachable.has(reachablePairKey(parts.agentSlug, parts.jobSlug))) {
        continue
      }
      if (agentFilter && parts.agentSlug !== agentFilter) {
        continue
      }
      if (jobFilter && parts.jobSlug !== jobFilter) {
        continue
      }
      out.push({
        sessionKey: entry.key,
        agent: parts.agentSlug,
        job: parts.jobSlug,
        title: entry.title ?? '',
        createdAt: entry.createdAt,
        // Dead sessions have no in-memory state to read a real activity time
        // from (agent-client sessions don't survive a restart) — fall back to
        // createdAt rather than fabricate one.
        lastActivityAt: metaByKey.get(entry.key)?.lastActivityAt ?? entry.createdAt,
        status: deriveSessionStatus(entry.key, sessionKeys),
        contextUsage: toContextUsage(metaByKey.get(entry.key)?.usage),
        queuedMessages: metaByKey.get(entry.key)?.queuedMessages ?? 0,
      })
    }
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return out
  },

  async listTurns(nodeId, params) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const sessionKey = params.sessionKey.trim()
    const parts = sessionKey ? parseSessionKey(sessionKey) : null
    if (!parts || !reachablePairs(found.nodes, found.edges).has(reachablePairKey(parts.agentSlug, parts.jobSlug))) {
      throw new Error(`Session not reachable from this node: ${sessionKey || '(empty)'}`)
    }
    return turnsPageForSessionKey(sessionKey, { turns: params.turns, beforeIndex: params.beforeIndex })
  },

  async compact(nodeId, params) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const sessionKey = params.sessionKey.trim()
    const parts = sessionKey ? parseSessionKey(sessionKey) : null
    // Same reachability scoping as listSessions/listTurns: a node may only act
    // on the sessions it could have sent to.
    if (!parts || !reachablePairs(found.nodes, found.edges).has(reachablePairKey(parts.agentSlug, parts.jobSlug))) {
      throw new Error(`Session not reachable from this node: ${sessionKey || '(empty)'}`)
    }

    // Accepts and returns immediately; the compaction itself — waiting out the
    // in-flight turn, both usage reads, the verdict, the conditional restore —
    // runs in the background and is queryable via compactStatus below. This
    // end owns only the node lookup and the reachability check.
    return requestCompactOnGraph(found.nodes, found.edges, sessionKey)
  },

  async compactStatus(nodeId, params) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const sessionKey = params.sessionKey.trim()
    const parts = sessionKey ? parseSessionKey(sessionKey) : null
    if (!parts || !reachablePairs(found.nodes, found.edges).has(reachablePairKey(parts.agentSlug, parts.jobSlug))) {
      throw new Error(`Session not reachable from this node: ${sessionKey || '(empty)'}`)
    }
    return getCompactStatusOnGraph(sessionKey)
  },

  async unload(nodeId, params) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const sessionKey = params.sessionKey.trim()
    const parts = sessionKey ? parseSessionKey(sessionKey) : null
    if (!parts || !reachablePairs(found.nodes, found.edges).has(reachablePairKey(parts.agentSlug, parts.jobSlug))) {
      throw new Error(`Session not reachable from this node: ${sessionKey || '(empty)'}`)
    }
    const status = deriveSessionStatus(sessionKey, {
      pending: new Set(agentClient.pendingPermissionSessionKeys()),
      active: new Set(agentClient.activeSessionKeys()),
      alive: new Set(agentClient.aliveSessionKeys()),
    })
    // Only an idle process is safe to unload: offline already has nothing
    // running, and working/waiting means the session's own harness may own
    // background work that a kill would silently drop with no way to resume it.
    if (status !== 'idle') {
      throw new Error(
        `Session is ${status}, not idle — unload only applies to an idle session (offline: no process to unload; working/waiting: unloading would kill in-flight work)`,
      )
    }
    await stopLocalSessionProcessImpl(sessionKey)
    return { sessionKey, unloaded: true }
  },

  async delete(nodeId, params) {
    const found = await findSendMessageNode(nodeId)
    if (!found) {
      throw new Error(`Node not found: ${nodeId}`)
    }
    const sessionKey = params.sessionKey.trim()
    const parts = sessionKey ? parseSessionKey(sessionKey) : null
    if (!parts || !reachablePairs(found.nodes, found.edges).has(reachablePairKey(parts.agentSlug, parts.jobSlug))) {
      throw new Error(`Session not reachable from this node: ${sessionKey || '(empty)'}`)
    }
    const force = params.force === true
    if (!force) {
      const status = deriveSessionStatus(sessionKey, {
        pending: new Set(agentClient.pendingPermissionSessionKeys()),
        active: new Set(agentClient.activeSessionKeys()),
        alive: new Set(agentClient.aliveSessionKeys()),
      })
      // The normal case is deleting an offline (stale) session. A live one
      // (idle/working/waiting) is refused by default since deleting it also
      // ends its process — pass force: true to end it and delete anyway.
      if (status !== 'offline') {
        throw new Error(
          `Session is ${status}, not offline — delete only applies to an offline session by default (pass force: true to end a live session and delete it anyway)`,
        )
      }
    }
    // Ends any live process, and drops the durable session pointer + config
    // overrides — safe to call unconditionally whether or not a process is
    // actually running (same call group-chat thread deletion already reuses).
    await forgetLocalSessionImpl(sessionKey)
    // forgetLocalSessionImpl only drops the durable session pointer, not the
    // human-facing chat-list entry — remove that separately so the session
    // also stops appearing in the sidebar.
    await deleteSessionEntry(sessionKey)
    return { sessionKey, deleted: true }
  },
}

// Resolve a terminal-context value from a node's output handle by invoking the
// owning extension's exposeOutput. Lazy imports avoid the host<->loader cycle.
async function getTerminalContext(nodeId: string, handleId: string): Promise<TerminalContext> {
  const node = await graphApi.getNode(nodeId)
  if (!node?.type) {
    throw new Error(`Node not found: ${nodeId}`)
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
