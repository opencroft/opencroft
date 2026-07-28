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

import { foldEvents } from 'agent-client/fold'
import type { ChatEvent } from 'agent-client/types'

import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { readSessions } from '@/app/(agent)/_server/agent-sessions-store'
import { deriveSessionStatus, type SessionStatus } from '@/app/(agent)/_shared/session-status'
import { dispatchExecutionContext, type ExecDispatchSummary } from '@/app/(extension-runtime)/_server/exec-dispatch'
import { parseSessionKey } from '@/app/(extension-runtime)/_server/send-message-helpers'
import {
  deliverToSendMessageNode,
  type GraphEdgeLike as SendMessageEdgeLike,
  type GraphNodeLike as SendMessageNodeLike,
} from '@/app/(extension-runtime)/_server/stream'
import { slug } from '@/app/(server)/_server/types'
import { getSetting, setSetting } from '@/app/(settings)/_server/actions'
import { getSettingImpl, setSettingImpl } from '@/app/(settings)/_server/settings-impl'
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
    const { listExtensionManifestsImpl } = await import('@/app/(extension-runtime)/_server/extension-action-impl')
    const { buildNodeTypeHandles, expandDynamicHandles, findDockerExtensionId } = await import(
      '@/app/(extension-runtime)/_server/node-handles'
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

// The agent/job slug pairs a send-message node can route to — same edge-walk
// listAgents has always used, factored out so listSessions/listTurns can
// filter the (node-independent) persisted session registry down to only the
// sessions THIS node could actually reach, matching listAgents' own scoping.
function reachableAgentJobs(
  nodes: SendMessageNodeLike[],
  edges: SendMessageEdgeLike[],
): { agent: string; jobs: string[] }[] {
  const jobsByAgentId = new Map<string, string[]>()
  for (const edge of edges) {
    const job = nodes.find((n) => n.id === edge.source && n.type === 'agent-job')
    const jobName = (job?.data?.['name'] as string | undefined)?.trim()
    if (!job || !jobName) {
      continue
    }
    const list = jobsByAgentId.get(edge.target) ?? []
    list.push(slug(jobName))
    jobsByAgentId.set(edge.target, list)
  }
  const out: { agent: string; jobs: string[] }[] = []
  for (const node of nodes) {
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
}

function reachablePairKey(agent: string, job: string): string {
  return `${agent}::${job}`
}

function reachablePairs(nodes: SendMessageNodeLike[], edges: SendMessageEdgeLike[]): Set<string> {
  return new Set(reachableAgentJobs(nodes, edges).flatMap((a) => a.jobs.map((j) => reachablePairKey(a.agent, j))))
}

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
  events.forEach((event, offset) => {
    if (event.kind === 'user') {
      // A prompt arrives as a RUN of 'user' events — one per content delta, the
      // same way a reply does — so only the FIRST of a run opens a turn. Opening
      // one per event splits a chunked message into several turns, the leading
      // ones holding a fragment and no terminal event, which then read as cut
      // off. A run that starts the window has no predecessor to check and opens
      // a turn: a window cut cannot tell a continuation from a beginning.
      if (events[offset - 1]?.kind === 'user' && groups.length > 0) {
        groups[groups.length - 1].events.push(event)
        return
      }
      groups.push({ index: startIndex + offset, events: [event] })
      return
    }
    if (groups.length > 0) {
      groups[groups.length - 1].events.push(event)
    }
  })
  return groups
}

export interface HostSendMessageApi {
  send(nodeId: string, payload: Record<string, unknown>): Promise<{ sessionKey: string; created: boolean; forced: boolean }>
  listAgents(nodeId: string): Promise<{ agent: string; jobs: string[] }[]>
  listSessions(nodeId: string, params: { agent?: string; job?: string }): Promise<SessionSummary[]>
  listTurns(nodeId: string, params: { sessionKey: string; turns?: number; beforeIndex?: number }): Promise<TurnsPage>
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
      turns: groups.map((group, i) => buildTurnSummary(group.index, group.events, tailInProgress && i === groups.length - 1)),
      hasMore: window.hasMore,
      nextBeforeIndex: window.hasMore ? window.startIndex : null,
      sessionStatus,
    }
  },
}

// Resolve a terminal-context value from a node's output handle by invoking the
// owning extension's exposeOutput. Lazy imports avoid the host<->loader cycle.
async function getTerminalContext(nodeId: string, handleId: string): Promise<TerminalContext> {
  const node = await graphApi.getNode(nodeId)
  if (!node?.type) {
    throw new Error(`Node not found: ${nodeId}`)
  }
  const { listExtensionManifestsImpl } = await import('@/app/(extension-runtime)/_server/extension-action-impl')
  const manifests = await listExtensionManifestsImpl()
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
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      return (all[prefix + key] as T | undefined) ?? null
    },
    async set<T>(key: string, value: T): Promise<void> {
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      all[prefix + key] = value
      await setSettingImpl({ id: STORAGE_SETTING_ID, data: all })
    },
    async delete(key: string): Promise<void> {
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      delete all[prefix + key]
      await setSettingImpl({ id: STORAGE_SETTING_ID, data: all })
    },
    async list(): Promise<string[]> {
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      return Object.keys(all)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
    async clear(): Promise<void> {
      const all = (await getSettingImpl(STORAGE_SETTING_ID))?.data ?? {}
      for (const k of Object.keys(all)) {
        if (k.startsWith(prefix)) {
          delete all[k]
        }
      }
      await setSettingImpl({ id: STORAGE_SETTING_ID, data: all })
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
