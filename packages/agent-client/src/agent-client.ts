import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'

import type {
  McpServer as AcpMcpServer,
  Client,
  CompleteElicitationNotification,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationSchema,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

import type { AgentConnection } from './connection'
import { normalizeUsage } from './context-window'
import { errorMessage } from './errors'
import { isTerminalToolStatus, lastConversationEvent } from './fold'
import { type HarnessFailure, harnessStartError } from './harness-failure'
import { readMcpConfig, resolveMcpServers } from './mcp-config'
import { createMcpServer, type SkillHandler, type SkillsInput, type ToolsInput } from './mcp-server'
import type { McpServerConfig } from './mcp-types'
import { containerReachableMcpUrl } from './mcp-url'
import { createNativeHarness, type NativeHarnessConfig, type NativeSession } from './native-harness'
import {
  type EventsWindow,
  pageBeforeByRecords,
  pageBeforeByTurns,
  type RecordsWindow,
  tailByRecords,
  tailByTurns,
} from './pagination'
import { type PermissionHandler, permissionContext } from './permission-context'
import { type ResolvedPermissions, toolKey } from './permissions'
import { DEFAULT_PRESENCE, msUntilDue, presenceWindowMs } from './presence'
import { buildDelivery, type DeliveryNote } from './queue-tags'
import { buildSpawnConfig, findAdapter } from './resolve'
import { fileSkillHandler, fileSkills } from './skills'
import { findTurnBoundary } from './turns'
import type {
  AgentSelection,
  AvailableCommand,
  ChatEvent,
  Presence,
  PromptOrigin,
  QueuedPrompt,
  QueueMode,
  SessionMeta,
  SessionMode,
  SpawnConfig,
} from './types'

export interface ClientInfo {
  name: string
  version: string
}

// The permission contract a host implements lives in its own module, so that
// reading a request into it is testable without an agent on the other end.
export type { PermissionContext, PermissionHandler, PermissionOutcome } from './permission-context'

export interface AgentClientOptions {
  mcpServerName?: string
  tools?: ToolsInput
  skills?: SkillsInput
  skillHandler?: SkillHandler
  // Always-on MCP servers injected into every session, in addition to the
  // built-in local server and the user-configured ones.
  extraMcpServers?: AcpMcpServer[]
  // Source the user-configured MCP servers (defaults to reading mcp-config.json).
  // Lets a host store them elsewhere, e.g. a database, instead of on disk, and
  // scope the result using the selection's mcpIdentity if it wants to.
  loadMcpServers?: (selection: AgentSelection) => Promise<McpServerConfig[]>
  // System prompt and step cap for the in-process native harness (kind:'native'
  // adapter). Ignored by external ACP agents, which carry their own.
  systemPrompt?: string
  maxSteps?: number
  // Identifies this client to ACP agents during initialize().
  clientInfo?: ClientInfo
  // Host policy applied to every ACP permission request before it reaches the
  // user, on top of the per-session role permissions. Lets the host auto-approve
  // (e.g. an auto-approve toggle) or bypass approvals entirely (e.g. a YOLO
  // mode). Defaults to prompting the user.
  permissionHandler?: PermissionHandler
  // Applied to a prompt's text at the moment it is actually handed to the
  // harness — inside deliverPrompt, the one place every delivery path (an
  // idle direct send, a per-turn queue drain, a flush's joined batch) ends up.
  // Never applied at prompt()'s enqueue time, so a message held behind a
  // running turn is transformed with whatever is true when it is actually
  // delivered, not when it was sent. Lets a host inject delivery-time
  // metadata (e.g. a timestamp) without agent-client knowing anything
  // host-specific. Defaults to delivering text unchanged.
  transformDeliveredPrompt?: (text: string) => string
  // Notified for every event on every session, after it has been recorded and
  // fanned out to that session's subscribers. A read-only observation hook for
  // host state that has to outlive the in-memory session — e.g. persisting the
  // last reported context usage, which ACP offers no way to ask for and which
  // is otherwise lost when a session is unloaded. Never drives the engine: it
  // is called inside a try/catch so a throwing host observer cannot break the
  // emit, and its return value is ignored.
  onEvent?: (sessionId: string, event: ChatEvent) => void
  // Durable copy of the queue, for a host whose queue can outlive its process.
  //
  // The engine serves entirely from memory and never reads this to make a
  // decision: it is written after the in-memory queue has already changed, and
  // read once, when a session is opened. Absent, everything works exactly as
  // before and a queue simply does not survive a restart — which was fine while
  // a message waited seconds, and stops being fine under a daily reading
  // cadence. See QueueStore.
  queueStore?: QueueStore
  // The reading cadence a session should reopen at, if the host remembers one.
  //
  // Read at session open, BEFORE the durable queue is evaluated, and that
  // ordering is the whole reason this exists rather than being left to the host
  // to set afterwards: a queue restored under the default cadence is a queue
  // delivered immediately, which is exactly what an hourly session asked not to
  // happen. Returning undefined means "no cadence remembered" and leaves the
  // default in place.
  loadPresence?: (sessionKey: string) => Presence | undefined | Promise<Presence | undefined>
  // Host gate over ALL queued delivery. Consulted at the top of every drain:
  // while it returns true nothing is handed to any agent -- system entries
  // included -- and a `push` degrades to an ordinary enqueue instead of
  // interrupting the running turn, so a turn in flight always completes.
  // Messages keep enqueuing (and persisting through queueStore) exactly as
  // if a turn were running. When the gate reopens the host calls
  // resumeDelivery() to drain every idle session; a session with a turn
  // running drains at its own settlement, as always. Absent means never held.
  shouldHoldDelivery?: () => boolean
  /**
   * Open the session for a key that has a queue waiting but nothing in memory.
   *
   * The engine decides WHICH keys (their cadence says they are due now) and the
   * host decides HOW a session comes back — it owns the registry that says what
   * this key belongs to and how to resume it. The engine has no way to build a
   * session from a key alone and must not guess one.
   *
   * Must be resume-or-reuse, never a blind create: between the engine asking
   * whether a key is resident and this being called, something else may have
   * opened the same key, and a second session for one conversation delivers the
   * queue twice. A host with an idempotent resolve already has the right
   * function; a host without one should not invent it here.
   *
   * Absent means the wake covers only what is already in memory — the behaviour
   * from before this existed.
   */
  openSessionForKey?: (sessionKey: string) => void | Promise<void>
}

/**
 * Where a host keeps the queue so it outlives the process.
 *
 * Write-behind, deliberately: every method is called AFTER the in-memory queue
 * has already changed, and none of them is awaited on the send path. A store
 * that is slow delays durability; it must never delay a message. The cost of
 * that choice is bounded and known — a process killed between the enqueue and
 * the write loses that one message, where blocking the send would have made
 * every message wait for a disk.
 *
 * The engine issues its calls for one session key strictly one after another,
 * in the order it made them: a store never sees two engine writes for the same
 * key in flight at once, and `load` is called only after every write already
 * issued for that key has settled. Without that promise every store whose
 * writes do any asynchronous work of its own would have to re-derive ordering
 * for itself, and the one that didn't would let a remove overtake the append
 * it was meant to erase — leaving a durable row for a message that was already
 * delivered, to be replayed at the next open. Writes for DIFFERENT keys may
 * still run concurrently.
 *
 * Addressed by session KEY rather than session id: the id is per-process and a
 * restart mints a new one, so it cannot name the thing being restored into.
 * A session with no key is not persisted at all, because nothing could address
 * it afterwards.
 *
 * Errors are the host's to handle. The engine calls these fire-and-forget, so a
 * rejected promise must not escape — implementations log and swallow.
 *
 * WITH ONE EXCEPTION, and it is deliberate: `pendingKeys` is read to DECIDE,
 * not to restore. Every other call here is a durable copy written behind the
 * in-memory queue and read back only when a session opens; that one is asked
 * when the delivery gate reopens and its answer determines which sessions get
 * opened at all. Said here because the rest of this doc reads as "the store
 * never drives anything", which stopped being true when that method landed.
 */
export interface QueueStore {
  /**
   * Record one entry. `placement` mirrors what the in-memory queue just did:
   * `front` for the corrective guidance that jumps the line, `end` otherwise.
   * The store owns how order is represented; the engine only says where.
   */
  append(sessionKey: string, entry: QueuedPrompt, placement: 'front' | 'end'): void | Promise<void>
  /** Forget entries that have been delivered or removed by the reader. */
  remove(sessionKey: string, entryIds: string[]): void | Promise<void>
  /**
   * Forget everything held under a key that is being retired for good.
   *
   * Called by the HOST, never by the engine. Dropping a live session is not the
   * same as retiring it — a host also does that to stop an agent's process
   * while keeping the conversation, and clearing there would discard a queue
   * that is about to be restored into the reopened session. Only the host knows
   * which of its own deletions is final, so it makes this call.
   */
  clear(sessionKey: string): void | Promise<void>
  /** The queue as it was left, oldest first. Read once, when a session opens. */
  load(sessionKey: string): QueuedPrompt[] | Promise<QueuedPrompt[]>
  /**
   * Every key that currently holds an undelivered queue.
   *
   * THE ONE READ THE ENGINE MAKES TO DECIDE SOMETHING, rather than to restore
   * a session that already exists. Everything else here is written behind the
   * in-memory queue and read back only when a session opens; this is asked
   * when the host's delivery gate reopens, to find the queues whose session is
   * not in memory at all — after a restart, that is every held queue, so
   * without it a wake reaches nothing it was held for.
   *
   * Optional, and a store that omits it is not broken: the wake then covers
   * exactly the sessions it covered before, the ones already in memory. That
   * is the older behaviour, not a silent failure of the newer one.
   *
   * Order does not matter and duplicates are the engine's to tolerate. A key
   * whose queue has been fully delivered must NOT be returned — "holds a
   * queue" is the question, and answering it with every key ever seen would
   * make the engine open sessions for conversations that are finished.
   */
  pendingKeys?(): string[] | Promise<string[]>
}

type Subscriber = (event: ChatEvent) => void

interface SessionModes {
  available: SessionMode[]
  current: string
}

interface SessionState {
  meta: SessionMeta
  // The resolved selection is kept in memory so the engine can reconnect /
  // resume without any on-disk profile store.
  selection: AgentSelection
  events: ChatEvent[]
  subscribers: Set<Subscriber>
  // Per-session approval modes (replaces a single global slot).
  modes: SessionModes | null
  // Dynamic config options (mode/model/thought_level/etc.) the agent
  // advertised at session start, replaced wholesale on every
  // config_option_update. ACP agents only; empty for the native harness.
  configOptions: SessionConfigOption[]
  // Commands the agent advertised (available_commands_update), replaced
  // wholesale on every update. Unlike configOptions these never arrive in the
  // session/new response — the agent pushes them shortly after the session
  // opens, and again whenever its command set changes.
  commands: AvailableCommand[]
  // Effective per-tool / per-skill permissions; undefined = unrestricted.
  permissions?: ResolvedPermissions
  // Number of prompt promises currently in flight for this session — the
  // single source of truth for the turn guard every caller of prompt() goes
  // through. Sessions without mid-turn input only ever see 0/1 (one
  // prompt-turn at a time, the ACP default); a steering-capable agent can hold
  // several, and the turn is over only when the count returns to 0.
  activeTurns: number
  // Prompts received while a turn was active, delivered FIFO as turns end.
  // Every change is published as a 'queue' snapshot event.
  queue: QueuedPrompt[]
  // Set before an interrupt so the delivery it buys carries the note, and WHICH
  // note it carries — the queue-jump wording for a one-off push or a Stop, the
  // compact per-interrupt wording for High Attention. Written BEFORE the cancel,
  // never after: cancelling a real agent ends its turn synchronously enough that
  // a drain can run while the caller is still suspended, and a note set
  // afterwards arrives too late to be attached.
  nextDeliveryNote?: DeliveryNote
  /**
   * Whether readers have been shown a non-empty queue for this session.
   *
   * Batching moved to dequeue, so EVERY message passes through the queue — even
   * one sent to an idle session, which is enqueued and drained in the same
   * call. Announcing those would flash an ordinary message into the Unread list
   * and straight back out, on every send. So a snapshot goes out when a message
   * is actually held, and the clearing snapshot goes out only when there is
   * something announced to clear.
   */
  queueAnnounced?: boolean
  /** How often this session reads its queue. See Presence. */
  presence: Presence
  /**
   * The window rolled for the CURRENT waiting period, in ms.
   *
   * Held rather than recomputed because the `minutes` cadence is random within
   * a range: recomputing would move the deadline under its own timer, and the
   * wait would end when the dice agreed rather than after the interval. Rolled
   * when the queue starts waiting, and again whenever the cadence changes.
   */
  presenceWindowMs?: number
  /**
   * Armed while messages are waiting on Presence rather than on a turn.
   *
   * An idle session has no turn boundary coming, so nothing would ever ask
   * again — an hourly agent with a message waiting would simply never receive
   * it. Unref'd: a pending read is not a reason to keep the process alive.
   */
  presenceTimer?: ReturnType<typeof setTimeout>
  /**
   * Set when the next message delivery must ignore Presence: a `push`, or a
   * Stop with something unread. Somebody asking for attention now is not
   * waiting for a reading window.
   *
   * Deliberately NOT folded into `nextDeliveryNote`, which today happens to be
   * set in the same places. They answer different questions — "explain the
   * interrupt" and "skip the wait" — and an idle `push` needs the second
   * without the first, because it interrupted nothing.
   */
  bypassPresenceOnce?: boolean
  // True only while session/load is replaying this session's history. The
  // replay carries no turn boundaries of its own, so handleUpdate reconstructs
  // them while this is set — see the `user_message_chunk` case.
  replaying?: boolean
  // Set by refreshMcpServers() when it finds this session mid-turn, instead of
  // resuming it immediately — a resume rides the same connection a live
  // prompt is streaming over. settleTurn applies the deferred resume once the
  // turn that was running actually finishes, and clears this.
  pendingMcpRefresh?: boolean
  // Last usage_update seen, mirrored here (like modes/configOptions/queue) so
  // a windowed subscribe/getEventsWindow can synthesize it without scanning
  // history — see the SNAPSHOT_KINDS handling below. This is the DISPLAYED
  // value (see the monotonic-within-turn rule at the usage_update case below)
  // — it can lag the harness's true current reading while a turn is active.
  usage?: { used: number; size?: number }
  // The latest RAW usage_update reading for the active turn, even one the
  // monotonic-within-turn rule held back from `usage` — settleTurn applies it
  // in full at the turn boundary. See the usage_update case for why.
  pendingUsage?: { used: number; size?: number }
}

interface ConnEntry {
  // Absent for the in-process native harness, which has no subprocess.
  process?: ChildProcessWithoutNullStreams
  connection: AgentConnection
  // The session last prompted through this connection — scopes elicitation
  // routing per connection instead of globally.
  lastSessionId: string | null
  // Whether the agent advertised the `loadSession` capability at initialize
  // (session/load history replay). Clients MUST NOT call loadSession otherwise.
  // Only meaningful once `initialized` has resolved.
  loadSession: boolean
  // Resolves when initialize() has completed and `loadSession` is set. Every
  // caller (spawner and concurrent reusers) awaits this before using the
  // connection, so capability checks never race a half-open connection.
  initialized: Promise<void>
}

interface ClientStore {
  // One live harness subprocess per distinct spawn config (keyed by spawnKey).
  connections: Map<string, ConnEntry>
  sessions: Map<string, SessionState>
  lastSessionId: string | null
  pendingPermissions: Map<
    string,
    {
      sessionId: string
      resolve: (response: RequestPermissionResponse) => void
    }
  >
  pendingElicitations: Map<
    string,
    {
      sessionId: string
      resolve: (response: CreateElicitationResponse) => void
      // The agent's own id for a URL elicitation — what its
      // elicitation/complete notification names, since the agent never
      // learns our requestId.
      elicitationId?: string
    }
  >
  // Native-harness conversation state, owned here (not in the harness closure)
  // so it survives dev hot-reloads while the harness object is rebuilt fresh.
  nativeSessions: Map<string, NativeSession>
  // Per-session-token permissions for the built-in MCP server (ACP sessions
  // pass the token via the 'x-agent-session' header). The token maps to its
  // session id once newSession returns.
  acpTokenPermissions: Map<string, ResolvedPermissions | undefined>
  acpTokenSession: Map<string, string>
  // Monotonic chat counter for default titles (delete-proof, unlike map size).
  titleCounter: number
}

function createStore(): ClientStore {
  return {
    connections: new Map(),
    sessions: new Map(),
    lastSessionId: null,
    pendingPermissions: new Map(),
    pendingElicitations: new Map(),
    nativeSessions: new Map(),
    acpTokenPermissions: new Map(),
    acpTokenSession: new Map(),
    titleCounter: 0,
  }
}

const globalRef = globalThis as typeof globalThis & {
  __acpStore?: ClientStore
}
if (!globalRef.__acpStore) {
  globalRef.__acpStore = createStore()
}
const store = globalRef.__acpStore
// The store survives dev hot-reloads, so createStore() doesn't re-run to add
// fields introduced later. Backfill any missing fields without clobbering the
// existing live maps (each ??= only fills a field a stale store lacks).
store.connections ??= new Map()
store.sessions ??= new Map()
store.pendingPermissions ??= new Map()
store.pendingElicitations ??= new Map()
store.nativeSessions ??= new Map()
store.acpTokenPermissions ??= new Map()
store.acpTokenSession ??= new Map()
store.lastSessionId ??= null
store.titleCounter ??= 0

function textOf(content: ContentBlock): string {
  if (content.type === 'text') {
    return content.text
  }
  return `[${content.type}]`
}

// Extract display text from an ACP/MCP content shape (a block, an array of
// blocks, or a { content } envelope). Returns null when the value isn't a
// recognizable block so the caller can pick a fallback. Non-text blocks
// (image, resource, diff, terminal, …) become a typed placeholder for now;
// rich rendering is tracked separately.
function blockText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const parts = value.map(blockText)
    return parts.some((part) => part === null) ? null : parts.join('\n')
  }
  if (value && typeof value === 'object') {
    const block = value as Record<string, unknown>
    if ('content' in block) {
      return blockText(block.content)
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text
    }
    if (typeof block.type === 'string') {
      return `[${block.type}]`
    }
  }
  return null
}

// Strip a single wrapping markdown code fence. Agents often fence tool output
// in `content` for clients that render markdown; clients that show tool output
// verbatim would otherwise render the fence as literal backticks.
function stripCodeFence(text: string): string {
  const match = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return match ? match[1] : text
}

// Flatten tool-call output to display text. The client renders this verbatim, so
// prefer the clean `rawOutput` string; the protocol's `content` is often a
// markdown-fenced copy meant for markdown renderers. Fall back to `content`
// (fence-stripped), then to stringifying genuinely opaque (non-block) data.
// Extracting text here also avoids JSON.stringify leaking `{ "type": "text", … }`.
function toolOutputText(content: ToolCallContent[] | null | undefined, rawOutput: unknown): string | undefined {
  if (typeof rawOutput === 'string' && rawOutput.trim()) {
    return rawOutput
  }
  if (content && content.length > 0) {
    const text = blockText(content)
    if (text !== null) {
      return stripCodeFence(text)
    }
  }
  if (rawOutput === undefined || rawOutput === null) {
    return undefined
  }
  const text = blockText(rawOutput)
  return text !== null ? stripCodeFence(text) : JSON.stringify(rawOutput, null, 2)
}

// Whether a replayed transcript's last conversation event shows work that had
// FINISHED rather than work still in flight — the evidence loadSession uses to
// guess how the last replayed turn ended, since the replay never says.
//
// The agent's own message is the clearest form: it spoke, then the session went
// quiet. A tool call in a terminal status is the same shape without closing
// text, which some turns genuinely end on — reading those as unfinished would
// report a completed turn as cut off, which is the wrong direction to be wrong
// in. Anything else — a tool still running, a question left unanswered, a step
// that stops halfway — is what an interrupted turn leaves behind.
function endsOnSettledWork(tail: ChatEvent | undefined): boolean {
  if (!tail) {
    return false
  }
  if (tail.kind === 'agent_message') {
    return true
  }
  if (tail.kind === 'tool_call' || tail.kind === 'tool_update') {
    return isTerminalToolStatus(tail.status)
  }
  return false
}

// The host's optional observation hook (AgentClientOptions.onEvent), installed
// by createAgentClient. Module-level, like `store`, because emit() is
// module-level and fires for every session rather than per client instance.
let onEventHook: ((sessionId: string, event: ChatEvent) => void) | undefined

function emit(sessionId: string, event: ChatEvent): void {
  const session = store.sessions.get(sessionId)
  if (!session) {
    return
  }
  session.events.push(event)
  session.meta.lastActivityAt = Date.now()
  for (const subscriber of session.subscribers) {
    subscriber(event)
  }
  // After the subscribers, so a slow or throwing host observer can never delay
  // or break delivery to the actual clients of the stream.
  if (onEventHook) {
    try {
      onEventHook(sessionId, event)
    } catch {}
  }
}

// "Last value wins" state (modes/config/queue/title/usage) mirrored on the
// session itself as it changes (see handleUpdate below). A subscriber replayed
// only a windowed tail of `events` (see subscribe's `fromIndex`) would
// otherwise never see one of these if it last changed before the cut — so
// prepend the live value whenever the window doesn't already carry it. Reads
// off the session's live fields instead of scanning history, so this stays
// O(1) (well, O(window size) for the `has` checks) regardless of transcript
// size — the same trick the old modes-only version of this used, generalized
// to every snapshot-kind event.
function withSnapshotPrefix(session: SessionState, windowed: ChatEvent[]): ChatEvent[] {
  const has = (kind: ChatEvent['kind']) => windowed.some((event) => event.kind === kind)
  const prefix: ChatEvent[] = []
  if (session.modes && !has('modes')) {
    prefix.push({ kind: 'modes', available: session.modes.available, current: session.modes.current })
  }
  if (session.configOptions.length > 0 && !has('config_options')) {
    prefix.push({ kind: 'config_options', options: session.configOptions })
  }
  // `?? []` because session records that survived a dev hot-reload may predate
  // the field (the store outlives createStore — same backfill prompt() does
  // for `queue`).
  if ((session.commands ?? []).length > 0 && !has('available_commands')) {
    prefix.push({ kind: 'available_commands', commands: session.commands })
  }
  if (session.meta.title && !has('session_info')) {
    prefix.push({ kind: 'session_info', title: session.meta.title })
  }
  if (session.usage && !has('usage')) {
    prefix.push({ kind: 'usage', used: session.usage.used, size: session.usage.size })
  }
  if (session.queue.length > 0 && !has('queue')) {
    prefix.push({ kind: 'queue', items: [...session.queue] })
  }
  // Only when it is not the default, matching every line above: absent means
  // realtime, which is what DEFAULT_PRESENCE documents and what a session that
  // has never been told otherwise is actually doing. Synthesizing one for every
  // session would also put an event in a windowed read that the live subscribe
  // replay does not have, and those two must agree.
  if (session.presence.kind !== DEFAULT_PRESENCE.kind && !has('presence')) {
    prefix.push({ kind: 'presence', presence: session.presence })
  }
  return prefix.length > 0 ? [...prefix, ...windowed] : windowed
}

// Drop every per-session MCP token minted for a session so the token maps don't
// grow unbounded as sessions are deleted or repeatedly resumed.
function dropSessionTokens(sessionId: string): void {
  for (const [token, mapped] of store.acpTokenSession) {
    if (mapped === sessionId) {
      store.acpTokenSession.delete(token)
      store.acpTokenPermissions.delete(token)
    }
  }
}

// Dispatches an inbound session/update notification to store state + a
// ChatEvent. Exported so tests can drive it directly — the real caller is the
// ACP Client wired up per spawned connection (buildClient below), which test
// mocks bypass entirely by seeding store.connections with a fake AgentConnection.
export function handleUpdate(notification: SessionNotification): void {
  const { sessionId, update } = notification
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      // Only arrives during session/load replay — live user turns are emitted
      // locally by prompt(). Surfacing it lets a resumed conversation show the
      // user's side of the history, not just the agent's replies.
      //
      // The replay carries no turn boundaries, so reconstruct one at the start
      // of every replayed message after the first: a turn that another prompt
      // follows must have ended, whatever ended it. Without this each replayed
      // turn contains no terminal event and reads as cut off.
      //
      // A message arrives as a RUN of chunks, so the boundary opens only when
      // the previous CONVERSATION event was not itself a user chunk — otherwise
      // a message split across two chunks would be reported as two turns. It
      // has to skip snapshots: `emit` stores every kind, so a config or title
      // update landing mid-run would otherwise read as "not a user chunk" and
      // split the message on an event that is not part of it at all.
      const session = store.sessions.get(sessionId)
      const previous = session?.replaying ? lastConversationEvent(session.events) : undefined
      if (previous && previous.kind !== 'user') {
        emit(sessionId, { kind: 'turn_end', stopReason: 'replayed' })
      }
      emit(sessionId, { kind: 'user', text: textOf(update.content) })
      break
    }
    case 'agent_message_chunk': {
      emit(sessionId, { kind: 'agent_message', text: textOf(update.content) })
      break
    }
    case 'agent_thought_chunk': {
      emit(sessionId, { kind: 'agent_thought', text: textOf(update.content) })
      break
    }
    case 'tool_call': {
      emit(sessionId, {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status ?? 'pending',
        toolKind: update.kind,
        input: update.rawInput,
      })
      break
    }
    case 'tool_call_update': {
      emit(sessionId, {
        kind: 'tool_update',
        toolCallId: update.toolCallId,
        title: update.title ?? undefined,
        status: update.status ?? undefined,
        input: update.rawInput ?? undefined,
        output: toolOutputText(update.content, update.rawOutput),
      })
      break
    }
    case 'plan': {
      emit(sessionId, {
        kind: 'plan',
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
          priority: entry.priority,
        })),
      })
      break
    }
    case 'current_mode_update': {
      const session = store.sessions.get(sessionId)
      if (session?.modes) {
        session.modes.current = update.currentModeId
      }
      emit(sessionId, { kind: 'mode_changed', current: update.currentModeId })
      break
    }
    case 'usage_update': {
      const session = store.sessions.get(sessionId)
      if (!session) {
        break
      }
      // Which window this reading may be shown against -- a window we know,
      // or none at all. See normalizeUsage: the harness's own `size` is only
      // an authority when we computed it (a native session), because a bridged
      // one cannot be told apart from that bridge's seeded default.
      //
      // This replaced a narrower rule that only intervened when the reading
      // contradicted itself (`used > size`). That caught the impossible case
      // and left every merely-false one alone, so a window was corrected
      // exactly once it had already misreported past 100%, and stayed wrong
      // while it was quietly wrong below it.
      //
      // The same call is what restoreUsage makes. One function, both doors:
      // the two had drifted, and the restored door was the one still open.
      const { size } = normalizeUsage(session.selection, { used: update.used, size: update.size })
      // Monotonic-within-turn display: an external ACP bridge resets its own
      // running usage tally at the start of every turn and rebuilds it from
      // streamed deltas, so a turn's early readings
      // undercount and climb back up over the turn's lifetime — confirmed
      // against @agentclientprotocol/claude-agent-acp's source: it nulls its
      // tally on turn activation, and cache-token fields it sums into `used`
      // aren't guaranteed populated until a later delta. Showing every
      // reading as-is made the ring visibly collapse and refill each turn.
      //
      // While a turn is active, a reading lower than what's currently
      // displayed is held rather than shown: the true reading is still kept
      // as `pendingUsage` and applied in full at the turn boundary (see
      // settleTurn), which is also where a genuine decrease (e.g. after
      // compaction) takes effect.
      //
      // The protocol carries no field to tell a genuine compaction-driven
      // decrease apart from an ordinary early-turn undercount — both are just
      // a lower `used`. So a compaction that lands mid-turn (SDK
      // auto-compaction inside one long tool-calling turn, as opposed to an
      // explicit /compact command's own turn) is held with everything else
      // and only takes effect once the turn ends. Accepted: this fails toward
      // a stale-but-higher number, never an incorrect drop, and self-corrects
      // at the boundary. Telling the two apart would need an upstream
      // protocol marker, not a guess made in this shared layer.
      //
      // The hold only makes sense comparing readings of the SAME window: a
      // `size` change — a restored session whose persisted pair predates a
      // window change, or a mid-session model switch — means the two numbers
      // describe different windows, not that context shrank. Observed live: a
      // restart restored a stale pair saved under an old (smaller) window,
      // and the first fresh reading under the current (larger) window had a
      // lower `used` — the hold read that as an undercount and sat on the
      // stale pair for the whole turn. A `size` change is a new-window signal
      // and always applies immediately, whichever way `used` moves; only a
      // same-size reading is a candidate for the hold above.
      session.pendingUsage = { used: update.used, size }
      if (session.activeTurns > 0 && session.usage && size === session.usage.size && update.used < session.usage.used) {
        break
      }
      session.usage = { used: update.used, size }
      emit(sessionId, { kind: 'usage', used: update.used, size })
      break
    }
    case 'config_option_update': {
      const session = store.sessions.get(sessionId)
      if (session) {
        session.configOptions = update.configOptions
      }
      emit(sessionId, { kind: 'config_options', options: update.configOptions })
      break
    }
    case 'available_commands_update': {
      const session = store.sessions.get(sessionId)
      if (session) {
        session.commands = update.availableCommands
      }
      emit(sessionId, { kind: 'available_commands', commands: update.availableCommands })
      break
    }
    case 'session_info_update': {
      // Per spec, `title: null` means "clear the title" — not handled here,
      // so a clear leaves the last known title in session.meta (the event
      // still emits with title: undefined either way).
      const session = store.sessions.get(sessionId)
      if (session && update.title) {
        session.meta.title = update.title
      }
      emit(sessionId, { kind: 'session_info', title: update.title ?? undefined })
      break
    }
    default:
      break
  }
}

// A tool with AlwaysAllow access skips the permission prompt. The native harness
// gates AlwaysAllow itself; this also catches the ACP path, where the agent
// raises the request (its toolCall.title is matched best-effort against slugs).
function isAlwaysAllowed(perms: ResolvedPermissions | undefined, title: string): boolean {
  if (!perms || perms.mode === 'none') {
    return false
  }
  if (perms.mode === 'all') {
    return perms.defaultAccess === 'AlwaysAllow'
  }
  if (perms.allow[toolKey(title)] === 'AlwaysAllow') {
    return true
  }
  return Object.entries(perms.allow).some(
    ([key, value]) => value === 'AlwaysAllow' && key.startsWith('tool:') && title.includes(key.slice('tool:'.length)),
  )
}

// Pick the option that grants the call for THIS turn only. Prefer an
// "allow_once" kind: a programmatic approval must never select "allow_always",
// which would write a persistent "don't ask again" rule into the agent's own
// state and keep tools approved after the approval mode is turned back off.
// Fall back to any allow-kind option, then a conventional id.
function pickAllowOption(request: RequestPermissionRequest): string {
  const once = request.options.find((option) => option.kind === 'allow_once')
  if (once) {
    return once.optionId
  }
  return request.options.find((option) => option.kind.startsWith('allow'))?.optionId ?? 'allow'
}

// Resolve the session an elicitation belongs to, scoped to the connection it
// arrived on, with the global last-prompted session as a fallback. The optional
// permissionHandler lets the host auto-approve / bypass requests before they
// surface to the user; `mcpServerName` is the built-in server's name, which is
// what lets a permission request for one of the host's own tools be recognised
// as such and carry that tool's identity.
//
// Exported for the same reason handleUpdate is: the elicitation callbacks are
// only reachable through a real spawned connection, which tests replace with a
// seeded fake — driving the built Client directly is how they exercise this
// path at all.
export function buildClient(
  getElicitationSession: () => string | null,
  mcpServerName: string,
  permissionHandler?: PermissionHandler,
): Client {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      handleUpdate(notification)
    },
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const perms = store.sessions.get(request.sessionId)?.permissions
      const title = request.toolCall.title ?? ''
      if (isAlwaysAllowed(perms, title)) {
        return { outcome: { outcome: 'selected', optionId: pickAllowOption(request) } }
      }
      const outcome = permissionHandler ? await permissionHandler(permissionContext(request, mcpServerName)) : 'prompt'
      if (outcome === 'allow') {
        return { outcome: { outcome: 'selected', optionId: pickAllowOption(request) } }
      }
      if (outcome === 'deny') {
        return { outcome: { outcome: 'cancelled' } }
      }
      return new Promise<RequestPermissionResponse>((resolve) => {
        const requestId = randomUUID()
        store.pendingPermissions.set(requestId, {
          sessionId: request.sessionId,
          resolve,
        })
        emit(request.sessionId, {
          kind: 'permission_request',
          requestId,
          title: title || 'tool call',
          options: request.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            kind: option.kind,
          })),
        })
      })
    },
    createElicitation: (request: CreateElicitationRequest) =>
      new Promise<CreateElicitationResponse>((resolve) => {
        const sessionId = getElicitationSession() ?? store.lastSessionId
        if (!sessionId) {
          resolve({ action: 'cancel' })
          return
        }
        const requestId = randomUUID()
        // The mode union carries a `mode: string` catch-all, so an equality
        // check does not narrow it — the casts read exactly the field each
        // declared mode guarantees. An unknown mode falls through to the
        // plain-message prompt, which is also what every elicitation was
        // before modes existed.
        const form = request.mode === 'form' ? (request as { requestedSchema: ElicitationSchema }).requestedSchema : undefined
        const urlMode = request.mode === 'url' ? (request as { url: string; elicitationId: string }) : undefined
        store.pendingElicitations.set(requestId, {
          sessionId,
          resolve,
          ...(urlMode ? { elicitationId: urlMode.elicitationId } : {}),
        })
        emit(sessionId, {
          kind: 'ask_user',
          requestId,
          message: request.message,
          ...(form ? { form } : {}),
          ...(urlMode ? { url: urlMode.url } : {}),
        })
      }),
    // A URL elicitation usually ends from the agent's side — it detects the
    // out-of-band step finished (an OAuth login landed) and notifies, naming
    // its own elicitationId. Resolve the pending promise too: the agent races
    // it against its own completion and ignores the loser, while an
    // unresolved entry here would sit in the map forever.
    completeElicitation: (notification: CompleteElicitationNotification) => {
      for (const [requestId, pending] of store.pendingElicitations) {
        if (pending.elicitationId !== undefined && pending.elicitationId === notification.elicitationId) {
          store.pendingElicitations.delete(requestId)
          pending.resolve({ action: 'accept' })
          emit(pending.sessionId, { kind: 'ask_user_resolved', requestId })
          break
        }
      }
    },
    readTextFile: async (request: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
      const content = await readFile(request.path, 'utf8')
      return { content }
    },
    writeTextFile: async (request: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
      await writeFile(request.path, request.content, 'utf8')
      return {}
    },
  }
}

function toSessionModes(modes: {
  availableModes: { id: string; name: string; description?: string | null }[]
  currentModeId: string
}): SessionModes {
  return {
    available: modes.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description ?? undefined,
    })),
    current: modes.currentModeId,
  }
}

function spawnKey(config: SpawnConfig): string {
  return JSON.stringify(config)
}

// Map a generic effort word ("low" | "high" | …) to the value id of an ACP
// agent's thought_level select option, matching against its values/labels. The
// options may be flat or grouped; both are flattened defensively.
function matchReasoningValue(options: unknown, effort: string): string | undefined {
  if (!Array.isArray(options)) {
    return undefined
  }
  const flat: Array<{ name?: string; value?: string }> = []
  for (const entry of options as Array<Record<string, unknown>>) {
    if (Array.isArray(entry.options)) {
      flat.push(...(entry.options as Array<{ name?: string; value?: string }>))
    } else if (typeof entry.value === 'string') {
      flat.push(entry as { name?: string; value?: string })
    }
  }
  const wanted = effort.toLowerCase()
  const hit = flat.find(
    (option) =>
      typeof option.value === 'string' &&
      (option.value.toLowerCase().includes(wanted) || (option.name ?? '').toLowerCase().includes(wanted)),
  )
  return hit?.value
}

function isNativeSelection(selection: AgentSelection): boolean {
  return findAdapter(selection.adapterId)?.kind === 'native'
}

// The Claude Code bridge ships with extended thinking off unless a session
// explicitly requests it via the thought_level config option. Sensible-default
// these adapters to 'medium' so thought chunks flow without every profile
// having to opt in by hand; other adapters keep the current "off unless asked"
// behavior. An explicit 'off' from the user is never overridden — it's
// distinct from an unset ('') selection, which is what picks up this default.
function resolveReasoningEffort(selection: AgentSelection): string {
  if (selection.reasoningEffort === 'off') {
    return ''
  }
  if (selection.reasoningEffort) {
    return selection.reasoningEffort
  }
  return selection.adapterId === 'claude' || selection.adapterId === 'claude-subscription' ? 'medium' : ''
}

// Whether this agent accepts per-session MCP servers (tool support). Adapters
// opt out via `supportsTools: false` (e.g. OpenClaw's bridge rejects them), in
// which case the client sends an empty server list.
function supportsTools(selection: AgentSelection): boolean {
  return findAdapter(selection.adapterId)?.supportsTools !== false
}

// Whether this agent accepts a prompt while a turn is running, feeding it into
// the live turn as streaming input ("steering"). Declared per adapter — ACP
// has no capability for it — and off by default, in which case the engine
// queues mid-turn prompts and delivers them as turns end. Exported so hosts
// can adapt their turn-control UX to the same single flag.
export function supportsMidTurnInput(selection: AgentSelection): boolean {
  return findAdapter(selection.adapterId)?.supportsMidTurnInput === true
}

/** Whether an adapter's harness is verified to send ACP elicitations — see
 * the flag's own note in harness-adapters. By adapter id rather than
 * selection, because the consumer (a host's tools factory) holds a
 * ToolsCaller, not a selection. */
export function adapterSupportsElicitation(adapterId: string | undefined): boolean {
  return adapterId !== undefined && findAdapter(adapterId)?.supportsElicitation === true
}

// Forward the host's external session key to bridges that route by their own
// session key (e.g. OpenClaw's ACP bridge → Gateway). ACP agents that don't
// recognize `_meta.sessionKey` ignore it, so this stays harness-agnostic.
function sessionMeta(selection: AgentSelection): { sessionKey: string } | undefined {
  return selection.sessionKey ? { sessionKey: selection.sessionKey } : undefined
}

// Most sessions never get a `permissions` argument (no roles wired up for this
// deployment) — that has always meant "unrestricted", not "unauthenticated".
// The mcp-server auth gate needs to tell those two states apart (a *known*
// token with no configured restrictions vs. a token that doesn't resolve to
// any session at all), so a known token always resolves to a concrete
// ResolvedPermissions here — falling back to this unrestricted default rather
// than surfacing `undefined`, which the gate reserves for "unknown token".
const UNRESTRICTED_PERMISSIONS: ResolvedPermissions = { mode: 'all', allow: {}, defaultAccess: 'Allow' }

// Stderr lines kept per spawned harness, for harnessStartError to draw a
// failure message from — bounded so a chatty process can't grow this
// unboundedly across the connection's lifetime.
const STDERR_TAIL = 20

// How long to let a process's 'exit'/final stderr chunk arrive after its
// stdout closes before giving up and reporting with whatever evidence is in
// hand — these land in either order, milliseconds apart.
const EXIT_GRACE_MS = 200

export function createAgentClient(options: AgentClientOptions = {}) {
  onEventHook = options.onEvent
  const mcpServerName = options.mcpServerName ?? 'local'
  const clientInfo = options.clientInfo ?? { name: 'agent-client', version: '0.1.0' }
  const mcp = createMcpServer({
    name: mcpServerName,
    tools: options.tools ?? [],
    skills: options.skills ?? [],
    skillHandler: options.skillHandler,
    permissionsFor: (token) => {
      const sessionId = store.acpTokenSession.get(token)
      if (sessionId) {
        return store.sessions.get(sessionId)?.permissions ?? UNRESTRICTED_PERMISSIONS
      }
      if (store.acpTokenPermissions.has(token)) {
        return store.acpTokenPermissions.get(token) ?? UNRESTRICTED_PERMISSIONS
      }
      return undefined
    },
    // The identity is read off the session this token belongs to, never off
    // the request. A token still awaiting its newSession, or one that maps to
    // a session that has since gone, resolves to no identity — the caller is
    // unknown, which is a different thing from unrestricted.
    callerFor: (token) => {
      const sessionId = store.acpTokenSession.get(token)
      const session = sessionId ? store.sessions.get(sessionId) : undefined
      // sessionId only travels when it names a session that still exists —
      // a stale token's id would let a session-scoped tool address a
      // conversation that is gone.
      return {
        mcpIdentity: session?.selection.mcpIdentity,
        ...(session && sessionId ? { sessionId } : {}),
        ...(session ? { adapterId: session.selection.adapterId } : {}),
      }
    },
  })

  // The real MCP servers the native harness should attach in-process — the
  // configured ones plus any extras, but NOT the built-in local server (its
  // tools/skills already run in-process). Re-evaluated per turn.
  async function loadNativeMcpServers(selection: AgentSelection): Promise<AcpMcpServer[]> {
    const configured = options.loadMcpServers ? await options.loadMcpServers(selection) : await readMcpConfig()
    return [...(options.extraMcpServers ?? []), ...resolveMcpServers(configured)]
  }

  const nativeConfig: NativeHarnessConfig = {
    tools: options.tools ?? [],
    skills: options.skills ?? [],
    skillHandler: options.skillHandler,
    systemPrompt: options.systemPrompt,
    maxSteps: options.maxSteps,
    loadMcpServers: loadNativeMcpServers,
  }

  // Built-in local server + extras + configured servers. The internal entry is
  // returned separately so a per-session header can be attached to it only.
  async function buildMcpServers(
    selection: AgentSelection,
  ): Promise<{ internal: AcpMcpServer; servers: AcpMcpServer[] }> {
    const rawUrl = await mcp.ensureUrl()
    // A containerized harness reaches the internal server via `docker exec`
    // (see resolve.ts wrapInDocker), so the loopback address it was given has
    // to be swapped for one that sibling container can actually resolve.
    const url = selection.containerName ? containerReachableMcpUrl(rawUrl) : rawUrl
    const internal: AcpMcpServer = {
      type: 'http',
      name: mcpServerName,
      url,
      headers: [],
    }
    const configured = options.loadMcpServers ? await options.loadMcpServers(selection) : await readMcpConfig()
    return { internal, servers: [internal, ...(options.extraMcpServers ?? []), ...resolveMcpServers(configured)] }
  }

  // Tag the internal server entry with a per-session token so the MCP server can
  // apply that session's permissions. Other entries are untouched.
  function tagInternal(internal: AcpMcpServer, servers: AcpMcpServer[], token: string): AcpMcpServer[] {
    return servers.map((server) => {
      if (server !== internal) {
        return server
      }
      return { ...internal, headers: [{ name: 'x-agent-session', value: token }] }
    })
  }

  // The in-process harness has no subprocess and no persistent identity, so it's
  // rebuilt fresh on every call (always the latest code) over the shared,
  // store-owned session map. The elicitation getter resolves against the native
  // session last prompted through this engine.
  function ensureNativeConnection(selection: AgentSelection): AgentConnection {
    return createNativeHarness(
      buildClient(() => store.lastSessionId, mcpServerName, options.permissionHandler),
      selection,
      nativeConfig,
      store.nativeSessions,
    )
  }

  async function ensureConnection(selection: AgentSelection): Promise<AgentConnection> {
    if (isNativeSelection(selection)) {
      return ensureNativeConnection(selection)
    }
    const spawnConfig = buildSpawnConfig(selection)
    const key = spawnKey(spawnConfig)
    // One live harness subprocess per distinct spawn config. Distinct profiles
    // (different harness/model/cwd) keep their own connection so their sessions
    // run concurrently in the background; identical configs share one
    // multiplexed connection. The synchronous get→set below cannot interleave
    // (no await before set), so concurrent creates for the same key are safe.
    const existing = store.connections.get(key)
    if (existing) {
      await existing.initialized
      return existing.connection
    }
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      // Empty cwd (docker-exec form sets the container workdir via `-w`) falls
      // back to the host default rather than failing to resolve.
      cwd: spawnConfig.cwd || undefined,
      env: { ...process.env, ...spawnConfig.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, launchers like `npx`/`npm` are `.cmd` scripts that Node's
      // spawn can't resolve on PATH without a shell, so they ENOENT otherwise.
      // Args here come from the fixed harness-adapter table, not user input.
      shell: process.platform === 'win32',
    })
    // Kept, not just logged: if the handshake below fails, this is what tells
    // the caller why the process is gone (see harnessStartError).
    const failure: HarnessFailure = { stderr: [] }
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      console.error('[acp-agent]', text)
      failure.stderr.push(text)
      if (failure.stderr.length > STDERR_TAIL) {
        failure.stderr.shift()
      }
    })
    // Without an 'error' listener a failed spawn throws at the process level and
    // takes the host server down; handle it so the failure surfaces as a rejected
    // initialize()/prompt() instead.
    child.on('error', (error) => {
      console.error('[acp-agent] spawn failed:', error)
      failure.spawnError = error
      store.connections.delete(key)
    })
    child.on('exit', (code, signal) => {
      failure.exit = { code, signal }
      store.connections.delete(key)
    })
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    // The client factory closes over `entry.lastSessionId` to scope elicitations
    // to this connection. The factory only runs lazily (on the first message),
    // by which point `entry` is assigned — so the forward reference is safe.
    let entry: ConnEntry
    const connection = new ClientSideConnection(
      () => buildClient(() => entry.lastSessionId, mcpServerName, options.permissionHandler),
      stream,
    )
    entry = { process: child, connection, lastSessionId: null, loadSession: false, initialized: Promise.resolve() }
    store.connections.set(key, entry)
    entry.initialized = (async () => {
      try {
        const initResult = await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            // Declaring form/url is the opt-in that makes agents SEND
            // elicitations at all: claude-agent-acp only converts its
            // AskUserQuestion tool into a form elicitation, forwards MCP
            // elicitations, and raises URL (OAuth) elicitations for clients
            // that advertised the matching mode — an `elicitation: {}` with
            // neither key means those degrade to a permission dialog / an
            // auto-decline. `{}` per mode is the spec's spelling of "supported"
            // (presence advertises, the object is room for future detail).
            elicitation: { form: {}, url: {} },
          },
          clientInfo,
        })
        entry.loadSession = Boolean(
          (initResult as { agentCapabilities?: { loadSession?: boolean } }).agentCapabilities?.loadSession,
        )
      } catch (error) {
        // The handshake fails the moment the process's stdout closes, which can
        // land marginally before its last stderr chunk and its 'exit' — so give
        // those a tick to arrive rather than reporting a failure with the
        // evidence missing. Only on the failure path, so it costs nothing
        // otherwise.
        await new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS))
        throw harnessStartError(failure, error)
      }
    })()
    await entry.initialized
    return connection
  }

  // Reconnects a session and pushes it the current MCP server list. Shared by
  // the public resumeSession() and refreshMcpServers' deferred path (via
  // settleTurn) — the latter is the reason this can't just live inline in
  // resumeSession: it needs to be callable without going through `this`.
  async function performResumeSession(sessionId: string): Promise<void> {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    const connection = await ensureConnection(session.selection)
    let mcpServers: AcpMcpServer[] = []
    if (!isNativeSelection(session.selection) && supportsTools(session.selection)) {
      // Retire the prior token for this session before minting a new one so
      // repeated resumes (e.g. on every MCP-config refresh) don't leak tokens.
      // permissionsFor resolves via the session record, which is already set.
      dropSessionTokens(sessionId)
      const { internal, servers } = await buildMcpServers(session.selection)
      const token = randomUUID()
      store.acpTokenSession.set(token, sessionId)
      mcpServers = tagInternal(internal, servers, token)
    }
    await connection.resumeSession({
      sessionId,
      cwd: session.selection.cwd,
      mcpServers,
    })
  }

  // The connection entry backing a selection (subprocess connections only;
  // native harnesses are stateless and reuse the global last-session fallback).
  function connEntryFor(selection: AgentSelection): ConnEntry | undefined {
    if (isNativeSelection(selection)) {
      return undefined
    }
    return store.connections.get(spawnKey(buildSpawnConfig(selection)))
  }

  // Resolve a live connection for an already-created session, using the spawn
  // config of the session's recorded selection.
  async function connectionForSession(sessionId: string): Promise<AgentConnection> {
    const selection = store.sessions.get(sessionId)?.selection
    if (!selection) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
    return ensureConnection(selection)
  }

  function emitSessionModes(sessionId: string): void {
    const modes = store.sessions.get(sessionId)?.modes
    if (modes) {
      emit(sessionId, { kind: 'modes', available: modes.available, current: modes.current })
    }
  }

  function emitConfigOptions(sessionId: string): void {
    const options = store.sessions.get(sessionId)?.configOptions
    if (options) {
      emit(sessionId, { kind: 'config_options', options })
    }
  }

  // Publish the current queue as a snapshot event. The copy matters: events are
  // stored for replay, so a stored snapshot must not alias the live array that
  // later pushes/shifts would mutate.
  function emitQueue(sessionId: string, queue: QueuedPrompt[]): void {
    const session = store.sessions.get(sessionId)
    if (session) {
      session.queueAnnounced = queue.length > 0
    }
    emit(sessionId, { kind: 'queue', items: [...queue] })
  }

  // Signal the agent to stop. Shared by the public `cancel` and by a `push`,
  // which has to interrupt before it can deliver — one implementation, so the
  // two can never disagree about what stopping a turn involves.
  //
  // Only a signal: it does not touch activeTurns or the queue. Whatever ends
  // the cancelled turn's in-flight prompt is what actually drains it (see
  // settleTurn), which is why a push queues rather than delivering directly.
  async function cancelSession(sessionId: string): Promise<void> {
    if (!store.sessions.has(sessionId)) {
      return
    }
    const connection = await connectionForSession(sessionId)
    await connection.cancel({ sessionId })
  }

  // Hand one prompt to the agent. The in-flight counter is incremented
  // synchronously (before any await), so a concurrent prompt() arriving in the
  // same tick sees the active turn and queues (or steers) instead of racing
  // past the guard. The counter is released — and the next queued prompt
  // delivered — only by settleTurn, once this prompt's promise settles.
  async function deliverPrompt(sessionId: string, text: string): Promise<void> {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    // The delivery-time transform, if the host supplied one — applied here,
    // not by any caller of prompt(), so it sees the text at the one instant
    // it is truly handed to the harness.
    const deliveredText = options.transformDeliveredPrompt ? options.transformDeliveredPrompt(text) : text
    session.activeTurns += 1
    let connection: AgentConnection
    try {
      connection = await connectionForSession(sessionId)
    } catch (error) {
      // No turn ever started (e.g. the harness failed to spawn) — release the
      // counter and drain, so queued prompts aren't stranded behind the
      // failure; each failed delivery surfaces its own error event.
      settleTurn(sessionId, {})
      throw error
    }
    store.lastSessionId = sessionId
    const entry = connEntryFor(session.selection)
    if (entry) {
      entry.lastSessionId = sessionId
    }
    emit(sessionId, { kind: 'user', text: deliveredText })
    void connection.prompt({ sessionId, prompt: [{ type: 'text', text: deliveredText }] }).then(
      (response) => settleTurn(sessionId, { stopReason: response.stopReason }),
      (error: unknown) => {
        // Failures surface immediately, even while other prompts are still in
        // flight on this session — visibility beats state purity, at the cost
        // of a transient not-waiting blip in consumers that fold an error as
        // the end of a turn. The terminal bookkeeping still waits for the last
        // settlement (see settleTurn).
        emit(sessionId, { kind: 'error', message: errorMessage(error) })
        settleTurn(sessionId, {})
      },
    )
  }

  // Bookkeeping for one settled prompt promise. With mid-turn input several
  // prompts can overlap on one session, and only the LAST settlement ends the
  // turn: it emits turn_end (with its own stopReason — intermediate
  // stopReasons are dropped, they describe a turn that kept running) and
  // drains the next queued prompt. A failed settlement has already emitted its
  // error, so `stopReason` is absent and a failed final settlement just
  // releases and drains — exactly the single-prompt error path of old. Queue
  // depth is small (hand-typed messages), so the drain's self-call chain stays
  // shallow: each delivery runs a full agent turn before the next drain.
  // Split out of settleTurn so a deferred MCP resume (see pendingMcpRefresh)
  // can run to completion first and still reach this: draining here while that
  // resume is still in flight would deliver a prompt over the same connection
  // the resume is using.
  /**
   * Take the leading run off the queue and deliver it as ONE prompt.
   *
   * This is where batching happens — at dequeue, not at send. A message waits as
   * itself, carrying its own author and time, and only becomes part of a batch
   * at the moment the queue is handed over. That is what lets a message keep its
   * true send time however long it waited.
   *
   * A run is either the leading stretch of consecutive `message` entries, or a
   * single `system` entry. System entries are never merged with anything and
   * never merge things across themselves, so `[A, /compact, B]` delivers as a
   * batch of A, then the command by itself, then a batch of B — three turns,
   * original order, and the command still first in its own prompt.
   *
   * The one time that order does not hold is the one time it cannot: while the
   * reading window is holding the leading messages, the first system entry
   * behind them is delivered alone and they keep waiting. A system entry is
   * never gated by the cadence, and being queued behind something that IS would
   * gate it by the back door — leaving whatever waits on its turn to report a
   * failure the session never had.
   *
   * Batching here is also what removed the interrupt race: whatever else has
   * happened by the time a drain runs, it takes the whole leading run rather
   * than one entry, so a settle landing mid-cancel can no longer ship one stale
   * message on its own.
   */
  function drainQueue(sessionId: string): Promise<void> | undefined {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return undefined
    }
    const queue = session.queue ?? []
    // The host's delivery gate sits above EVERYTHING in this function -- the
    // system-entry fast-path included, because a hold in which "nothing is
    // delivered" quietly exempted system entries would not be a hold. Held
    // entries stay queued and durable exactly as behind a running turn;
    // announcing them is what lets the host show what is waiting. Presence
    // timers left armed are harmless: they re-enter here and meet the gate.
    if (options.shouldHoldDelivery?.() === true) {
      if (queue.length > 0) {
        emitQueue(sessionId, queue)
      }
      return undefined
    }
    const run = leadingRun(queue)
    if (run.length === 0) {
      clearPresenceTimer(session)
      return undefined
    }
    // Presence gates MESSAGE runs only. A system entry is plumbing, not
    // conversation: compaction asked for now must not wait an hour because the
    // agent's reading cadence is hourly. A command is the same shape of thing —
    // someone invoking harness machinery now, not writing to be read at the
    // agent's cadence.
    if (run[0].kind === 'message' && !consumePresenceBypass(session)) {
      const waitMs = msUntilDue(run, presenceWindow(session), Date.now())
      if (waitMs !== null && waitMs > 0) {
        // Announced HERE rather than at enqueue, because this is the moment it
        // is known to be waiting. A message held by the reading window is
        // exactly as unread as one held by a running turn, and an idle session
        // has no turn to have announced it.
        emitQueue(sessionId, queue)
        armPresenceTimer(sessionId, session, waitMs)
        // "Never gated" has to mean never, including from BEHIND. A system
        // entry queued after messages the window is holding would otherwise
        // inherit their wait — and the caller waiting on its turn (compaction
        // does) reports a failure the reading cadence caused, on a session
        // where nothing is wrong.
        //
        // So it goes alone, and the messages stay exactly where they are: their
        // order among themselves is untouched, the window they are waiting on
        // keeps running, and the next drain finds them still due at the same
        // moment they always were.
        const ungated = queue.find((entry) => entry.kind !== 'message')
        return ungated ? dispatchRun(sessionId, session, [ungated]) : undefined
      }
    }
    clearPresenceTimer(session)
    return dispatchRun(sessionId, session, run)
  }

  /**
   * Hand one run to the agent: take it out of the queue, deliver it as a single
   * prompt, and drop the durable copy once it has actually been handed over.
   *
   * Entries are taken by ID rather than by position, because a run is not
   * always the head of the queue: a system entry that jumps a message run the
   * reading window is holding comes out of the middle.
   */
  function dispatchRun(sessionId: string, session: SessionState, run: QueuedPrompt[]): Promise<void> {
    const taken = new Set(run.map((entry) => entry.id))
    session.queue = (session.queue ?? []).filter((entry) => !taken.has(entry.id))
    // Nothing to correct when nothing was ever announced: a message that passed
    // straight through was never shown as waiting, so it needs no clearing.
    if (session.queueAnnounced || session.queue.length > 0) {
      emitQueue(sessionId, session.queue)
    }
    // The note belongs to the delivery the interrupt bought, so it is consumed
    // by the first MESSAGE delivery after it. A system entry drained in between
    // never carries one and must not swallow it either.
    const first = run[0]
    const note: DeliveryNote | undefined = first.kind === 'message' ? session.nextDeliveryNote : undefined
    if (note) {
      session.nextDeliveryNote = undefined
    }
    const text = buildRunDelivery(run, note)
    // Returned rather than fired and forgotten, so a send into an IDLE session
    // can await its own dispatch. Every message goes through the queue now, and
    // without this a send that nothing was holding up would resolve before the
    // prompt had reached the harness — turning what used to be "delivered by
    // the time this resolves" into a race the caller cannot see. Drains from a
    // turn settlement have nobody waiting and keep discarding it.
    return deliverPrompt(sessionId, text).then(
      () => {
        // Only now: the durable copy is what makes a message survive a process
        // that dies, so it must outlive every step that could still fail to
        // hand the message over. Dropped before the hand-over, a harness that
        // could not be reached lost the message outright — nothing held it any
        // more, in memory or on disk. Dropped after, that same failure leaves
        // the entry to be restored and delivered at the next open.
        //
        // The cost is a narrow window in the other direction: an entry is
        // durable while the hand-over is in flight, so a session reopened in
        // exactly that moment can deliver it twice. That is the trade this
        // whole path is built on — a message arriving twice is recoverable
        // where one that never arrives is not.
        persist(session, (store, key) =>
          store.remove(
            key,
            run.map((entry) => entry.id),
          ),
        )
      },
      (error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }),
    )
  }

  /**
   * The durable queue's address for a session, or null when it has none.
   *
   * A session with no key cannot be restored into after a restart — nothing
   * would know which session the rows belonged to — so it is not written
   * either. Writing rows nobody could ever read back is just a leak.
   */
  function queueKey(session: SessionState): string | null {
    return options.queueStore ? (session.meta.sessionKey ?? null) : null
  }

  /**
   * Durable-queue writes still in flight, per session key. The tail of a chain
   * is the promise the NEXT write for that key starts after, and the thing a
   * session open waits out before reading the store back (see
   * restoreSessionState). Keyed by session KEY rather than by the session
   * record, because the writes a reopen must not race were issued by the
   * previous session object under the same key. Entries remove themselves once
   * a chain has quiesced, so the map holds only keys with work outstanding.
   */
  const queueWrites = new Map<string, Promise<void>>()

  /**
   * Run a durable-queue write without letting it touch the send path.
   *
   * Not awaited and never able to throw into a caller: durability is a
   * side-channel here. A store that is slow delays the copy, not the message,
   * and a store that is broken costs a queue that does not survive a restart —
   * which is where every host without one already is.
   *
   * Writes for one key run strictly in the order they were issued, each
   * starting only after the previous one settled. Fired concurrently they
   * would race inside the store: any store whose write does asynchronous work
   * of its own can commit a remove before the append it was meant to erase,
   * and the leftover row replays an already-delivered message at the next
   * open. The engine is the one place the issue order is known, so the
   * ordering is kept here rather than asked of every store. A failed write is
   * logged and stepped over — it must not wedge the writes queued behind it.
   */
  function persist(session: SessionState, write: (store: QueueStore, key: string) => void | Promise<void>): void {
    const key = queueKey(session)
    if (!key || !options.queueStore) {
      return
    }
    const store = options.queueStore
    const tail = queueWrites.get(key) ?? Promise.resolve()
    const next = tail.then(async () => {
      try {
        await write(store, key)
      } catch (error) {
        console.error('[agent-client] durable queue write failed', error)
      }
    })
    queueWrites.set(key, next)
    void next.then(() => {
      if (queueWrites.get(key) === next) {
        queueWrites.delete(key)
      }
    })
  }

  /**
   * Put back what the previous process was still holding for this session.
   *
   * Awaited at session open, unlike every other durable-queue call: this one
   * has to finish before the session can take a message, or a restored message
   * would be prepended in front of one already delivered. Once per open is not
   * the hot path — the rule this stays off is the SEND path.
   *
   * The wait continues rather than restarting. Each message carries its own
   * send time, and the window is measured from the oldest of them, so an hourly
   * message that had waited fifty-nine minutes is due in one — the timer
   * re-arms itself from the persisted times with no arithmetic of its own.
   */
  async function restoreSessionState(sessionId: string): Promise<void> {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    const sessionKey = session.meta.sessionKey
    if (!sessionKey) {
      return
    }
    // The cadence FIRST, and this order is load-bearing: evaluating a restored
    // queue under the default cadence would deliver, at once, everything an
    // hourly session had been holding back — the restart itself becoming the
    // interruption the setting exists to prevent.
    if (options.loadPresence) {
      try {
        const presence = await options.loadPresence(sessionKey)
        if (presence) {
          session.presence = presence
          emit(sessionId, { kind: 'presence', presence })
        }
      } catch (error) {
        // Falling back to realtime reads early rather than never, which is the
        // safe direction for a setting that decides whether a message arrives.
        console.error('[agent-client] presence restore failed', error)
      }
    }
    if (!options.queueStore) {
      return
    }
    const key = queueKey(session)
    if (!key) {
      return
    }
    // Writes issued for this key earlier in THIS process can still be in
    // flight: a session is stopped and reopened without a restart, and the
    // remove for its last delivery races the reopen. Reading before that
    // remove lands would restore — and then redeliver — a message that was
    // already handed over. So the read starts only once the chain has
    // quiesced. Looped rather than awaited once, because a write chained
    // while this waits extends the chain past the tail it grabbed.
    for (let pending = queueWrites.get(key); pending; ) {
      await pending
      const tail = queueWrites.get(key)
      pending = tail === pending ? undefined : tail
    }
    let restored: QueuedPrompt[]
    try {
      restored = await options.queueStore.load(key)
    } catch (error) {
      // A queue that cannot be read back is the state every host without a
      // store is in permanently. Opening the session is still the right
      // outcome; refusing to would turn a lost queue into a lost session.
      console.error('[agent-client] durable queue restore failed', error)
      return
    }
    // Anything already in memory was sent to THIS process and is therefore
    // newer, so restored entries go in front of it. Ids are matched because a
    // resume can race a send: the same entry must not land twice.
    const known = new Set(session.queue.map((entry) => entry.id))
    const fresh = restored.filter((entry) => !known.has(entry.id))
    if (fresh.length === 0) {
      return
    }
    session.queue = [...fresh, ...session.queue]
    // Not announced here. The drain below decides whether these are actually
    // waiting — under a cadence that has already elapsed they go straight out
    // and were never unread — and it is the one place that announcement is
    // made. Publishing a snapshot here as well would show every restored queue
    // twice, including the ones that never waited at all.
    if (session.activeTurns === 0) {
      void drainQueue(sessionId)
    }
  }

  /**
   * The window in force for the CURRENT waiting period, rolled once and kept.
   *
   * Rolling per call would matter for the `minutes` cadence, which is random
   * within a range: the deadline would move every time it was checked, and the
   * wait would end when the dice agreed rather than after the interval.
   */
  function presenceWindow(session: SessionState): number {
    session.presenceWindowMs ??= presenceWindowMs(session.presence)
    return session.presenceWindowMs
  }

  /**
   * Whether this delivery skips the wait — and spends the right to do so.
   *
   * One-shot: a `push` bypasses the window for the delivery it bought, not for
   * everything that follows it. A cadence that stayed bypassed after one urgent
   * message would be a setting that quietly switched itself off.
   */
  function consumePresenceBypass(session: SessionState): boolean {
    if (!session.bypassPresenceOnce) {
      return false
    }
    session.bypassPresenceOnce = false
    return true
  }

  function clearPresenceTimer(session: SessionState): void {
    if (session.presenceTimer) {
      clearTimeout(session.presenceTimer)
      session.presenceTimer = undefined
    }
    // The window belongs to a waiting period, and this ends one. The next
    // message to wait rolls its own — otherwise the first `minutes` roll a
    // session ever made would govern every wait it had after that.
    session.presenceWindowMs = undefined
  }

  /**
   * Ask again when the window closes.
   *
   * The turn boundary cannot be relied on here: a session holding messages
   * under a non-realtime cadence is usually IDLE, so nothing is coming that
   * would prompt another look, and without this an hourly agent with a message
   * waiting would simply never receive it.
   *
   * Re-armed rather than left running when a newer message arrives, because the
   * window is measured from the oldest — the deadline does not move, but the
   * queue it will deliver does.
   *
   * `unref` so a pending read never keeps a process alive: a queue waiting for
   * tomorrow is not a reason for the host to stay up, and in tests it is the
   * difference between a suite that exits and one that hangs.
   */
  function armPresenceTimer(sessionId: string, session: SessionState, waitMs: number): void {
    if (session.presenceTimer) {
      clearTimeout(session.presenceTimer)
    }
    const timer = setTimeout(() => {
      session.presenceTimer = undefined
      // A window can now close while a turn is running: a system entry that
      // jumped the held messages started one. Delivering into it would put a
      // prompt over a live turn, which is the thing the queue exists to
      // prevent — and nothing is lost by declining, because that turn's own
      // settlement drains whatever has come due by then.
      if (session.activeTurns > 0 && !supportsMidTurnInput(session.selection)) {
        return
      }
      void drainQueue(sessionId)
    }, waitMs)
    timer.unref?.()
    session.presenceTimer = timer
  }

  /**
   * Build the queue entry for a prompt, or nothing when there is nothing to
   * send. The send time is stamped HERE, at enqueue, because that is when the
   * message was actually sent — a batch formed hours later must still report
   * when each part was written, not when it was handed over.
   */
  function toEntry(text: string, origin: PromptOrigin): QueuedPrompt | null {
    if (text.trim().length === 0) {
      return null
    }
    if (origin.kind === 'system') {
      return { id: randomUUID(), kind: 'system', text }
    }
    // A leading slash marks a harness command, never a conversational message.
    // The harness recognises it by the prompt's FIRST characters — no trimming
    // on its side — so the entry stores the text with the leading whitespace
    // already gone, and delivery skips the tags and notes a message would get.
    // The entry keeps its author for the queue UI.
    const lead = text.trimStart()
    if (lead.startsWith('/')) {
      return { id: randomUUID(), kind: 'command', sender: origin.sender, sentAt: new Date().toISOString(), text: lead }
    }
    return { id: randomUUID(), kind: 'message', sender: origin.sender, sentAt: new Date().toISOString(), text }
  }

  /** The leading run: consecutive messages, or exactly one system/command entry. */
  function leadingRun(queue: QueuedPrompt[]): QueuedPrompt[] {
    const first = queue[0]
    if (!first) {
      return []
    }
    if (first.kind !== 'message') {
      return [first]
    }
    const end = queue.findIndex((entry) => entry.kind !== 'message')
    return end === -1 ? [...queue] : queue.slice(0, end)
  }

  /** Turn a run into the one prompt it delivers. */
  function buildRunDelivery(run: QueuedPrompt[], note?: DeliveryNote): string {
    const first = run[0]
    if (first.kind !== 'message') {
      // System entries and commands go out exactly as given: a tag line or an
      // interrupt note in front of `/anything` stops it being a command.
      return buildDelivery({ kind: 'system', text: first.text })
    }
    const messages = run.map((entry) =>
      entry.kind === 'message'
        ? { sender: entry.sender, sentAt: entry.sentAt, text: entry.text }
        : { sender: '', sentAt: '', text: entry.text },
    )
    return buildDelivery({ kind: 'messages', messages, note })
  }

  function settleTurn(sessionId: string, outcome: { stopReason?: string }): void {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    session.activeTurns = Math.max(0, session.activeTurns - 1)
    if (session.activeTurns > 0) {
      return
    }
    // The turn boundary the usage_update case's monotonic rule promises
    // decreases for: apply the turn's true final reading now, even if it's
    // one that rule held back mid-turn. A no-op when the last applied
    // reading already matches (the common case — most turns never see a
    // held-back decrease at all).
    if (
      session.pendingUsage &&
      (!session.usage ||
        session.pendingUsage.used !== session.usage.used ||
        session.pendingUsage.size !== session.usage.size)
    ) {
      session.usage = session.pendingUsage
      emit(sessionId, { kind: 'usage', used: session.usage.used, size: session.usage.size })
    }
    if (outcome.stopReason !== undefined) {
      emit(sessionId, { kind: 'turn_end', stopReason: outcome.stopReason })
    }
    if (session.pendingMcpRefresh) {
      session.pendingMcpRefresh = false
      void performResumeSession(sessionId)
        .catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
        .then(() => drainQueue(sessionId))
      return
    }
    drainQueue(sessionId)
  }

  /**
   * Open the sessions a wake owes and nothing more: keys holding a queue that
   * is due NOW under their own cadence, and which nothing in this process is
   * holding.
   *
   * DUE ONLY, and that is the whole design rather than a saving. Opening every
   * key with a queue would, after a restart, start every held session at once
   * -- for an agent that is a process -- which is the stampede the gate was
   * closed to avoid. The due ones are also exactly the ones the operator meant
   * to resume; a session whose window has not elapsed is left where it was,
   * which is where it would have been had the gate never closed.
   *
   * The cadence question is answered by `msUntilDue`, the SAME function the
   * in-session drain asks. There is deliberately no second copy of the rule
   * here: a wake that decided due-ness its own way would drift from the drain
   * silently, and the two disagreeing is indistinguishable from either one
   * being wrong.
   */
  async function openDueAbsentSessions(): Promise<void> {
    const durable = options.queueStore
    const open = options.openSessionForKey
    if (!durable?.pendingKeys || !open) {
      return
    }
    // Asked again rather than assumed: this runs after an await, and a host
    // that went back to sleep in between must not have sessions started under
    // it. Each drain re-checks the gate for the same reason.
    if (options.shouldHoldDelivery?.() === true) {
      return
    }
    let keys: string[]
    try {
      keys = await durable.pendingKeys()
    } catch (error) {
      console.error('[agent-client] pendingKeys failed; the wake covers resident sessions only', error)
      return
    }
    const resident = new Set(
      [...store.sessions.values()].map((session) => session.meta.sessionKey).filter((key): key is string => !!key),
    )
    const now = Date.now()
    for (const key of new Set(keys)) {
      if (resident.has(key)) {
        continue
      }
      try {
        const queued = await durable.load(key)
        if (queued.length === 0) {
          continue
        }
        const presence = (await options.loadPresence?.(key)) ?? DEFAULT_PRESENCE
        // null means nothing here waits on a cadence at all -- a system entry
        // and no message. Those are never presence-gated, so "no window to
        // wait for" reads as due, not as "skip".
        const waitMs = msUntilDue(queued, presenceWindowMs(presence), now)
        if (waitMs === null || waitMs <= 0) {
          await open(key)
        }
      } catch (error) {
        // One key's failure must not strand the rest: a wake that stopped at
        // the first bad row would leave every later queue held with no second
        // chance coming.
        console.error('[agent-client] could not open a due session for its waiting queue', key, error)
      }
    }
  }

  return {
    /**
     * Drain every idle session's queue -- the other half of
     * shouldHoldDelivery, called by the host when its gate reopens. Sessions
     * with a turn in flight are left to their own settlement drain, the same
     * boundary every delivery already respects; each drain still consults the
     * gate, so calling this while the gate is closed delivers nothing.
     */
    resumeDelivery(): void {
      for (const [sessionId, session] of store.sessions) {
        if ((session.activeTurns ?? 0) === 0 && (session.queue?.length ?? 0) > 0) {
          void drainQueue(sessionId)
        }
      }
      // The loop above can only reach sessions this process still has. After a
      // restart that is none of them, which is exactly when a wake matters
      // most -- the restart is what the gate was closed for.
      void openDueAbsentSessions()
    },
    // `usage` is composed in here rather than stored on `meta`, so the live
    // session state stays the single source of truth for it.
    listSessions(): SessionMeta[] {
      return [...store.sessions.values()]
        .map((session) => ({
          ...session.meta,
          usage: session.usage,
          queuedMessages: session.queue.length,
          presence: session.presence,
        }))
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    // Seed a session's context usage from a value the host kept for it, for the
    // case a resume cannot recover on its own: ACP has no request that returns
    // a session's used/window figures (they arrive only as agent-pushed
    // `usage_update` notifications), so a session/load resume starts with none
    // and reports nothing until its next turn ends.
    //
    // Deliberately does NOT emit a `usage` event: on resume there is no
    // subscriber yet, and setting the mirrored value is enough for
    // withSnapshotPrefix to hand it to the first one that connects — the same
    // path a live reading takes. A real `usage_update` overwrites this the
    // moment the agent reports one, so a restored value can only ever be the
    // opening estimate, never sticky.
    //
    // No-ops for an unknown session rather than throwing: the caller is a
    // best-effort restore alongside a resume that may itself have failed.
    restoreUsage(sessionId: string, usage: { used: number; size?: number }): void {
      const session = store.sessions.get(sessionId)
      if (!session || session.usage) {
        return
      }
      // Normalised on the way in, exactly as a live reading is. What is handed
      // back here was persisted by an earlier session from the same harness
      // `size` a live reading has to justify, so it gets no weaker a test for
      // having survived a restart -- a restored figure that skipped this is
      // how an offline session came back still showing a window the live path
      // would have refused.
      session.usage = normalizeUsage(session.selection, usage)
    },

    // Session keys (selection.sessionKey) of every session currently blocked on
    // an unresolved permission request — lets a host badge those sessions.
    pendingPermissionSessionKeys(): string[] {
      const keys = new Set<string>()
      for (const { sessionId } of store.pendingPermissions.values()) {
        const key = store.sessions.get(sessionId)?.selection.sessionKey
        if (key) {
          keys.add(key)
        }
      }
      return [...keys]
    },

    // Session keys of every session with a turn currently in flight (one or
    // more prompt promises unsettled — see `activeTurns`) — lets a host badge
    // sessions that are actively thinking/streaming/running tools, independent
    // of the pending-permission state above (a session can only be one or the
    // other in practice: a turn blocked on a permission request has already
    // paused, but both reads are separate so a host can tell them apart).
    activeSessionKeys(): string[] {
      const keys = new Set<string>()
      for (const session of store.sessions.values()) {
        const key = session.selection.sessionKey
        if (session.activeTurns > 0 && key) {
          keys.add(key)
        }
      }
      return [...keys]
    },

    // Same underlying read as activeSessionKeys, but by raw session id and for
    // a single session — for a caller that already has the id (e.g. a `force`
    // send deciding whether there's actually a turn worth cancelling) and has
    // no reason to resolve it back to a selection.sessionKey first.
    hasActiveTurn(sessionId: string): boolean {
      return (store.sessions.get(sessionId)?.activeTurns ?? 0) > 0
    },

    // Session keys of every session with a *live agent process* right now —
    // i.e. present in `store.sessions` at all, whether idle, working, or
    // pending permission. A restarted server (or a session ended via
    // deleteSession without a matching close) has none until the tab's
    // session is next opened — see openLocalSession's cold-start resume.
    // Lets a host show "process alive" independent of activeSessionKeys
    // (working) and pendingPermissionSessionKeys (blocked).
    aliveSessionKeys(): string[] {
      const keys = new Set<string>()
      for (const session of store.sessions.values()) {
        const key = session.selection.sessionKey
        if (key) {
          keys.add(key)
        }
      }
      return [...keys]
    },

    // Move a live session from one external session key to another, WITHOUT
    // touching the conversation, the process, or anything in flight. For a host
    // whose keys are derived from something renameable: the session is the same
    // session, and only the name the host reaches it by has changed.
    //
    // Both copies of the key move together — `selection.sessionKey`, which the
    // key-based reads above answer from, and the mirror on `meta` that
    // `listSessions` publishes. Leaving either behind would make one of the two
    // answer with an address nothing else recognises.
    //
    // WHAT THIS DOES NOT DO, and it matters for bridge-backed harnesses: the
    // external key reaches an agent as ACP `_meta.sessionKey`, which is sent
    // when a session is CREATED or LOADED and never again. So a bridge that
    // bound its own routing to the old key keeps that binding for as long as
    // this session lives — the rename is invisible to it — and it is the next
    // cold-start resume, presenting the new key, that moves routing. A host
    // that needs the wire identity to outlive a rename has to keep the original
    // key itself and pass it back as `selection.sessionKey` on resume; this
    // engine has nowhere durable to remember it.
    //
    // Returns whether a live session actually answered to `from`. False is an
    // ordinary answer, not a failure: an unloaded session has no record here at
    // all, and its key lives only in whatever the host persisted.
    renameSessionKey(from: string, to: string): boolean {
      if (!from || !to || from === to) {
        return false
      }
      let moved = false
      for (const session of store.sessions.values()) {
        if (session.selection.sessionKey !== from) {
          continue
        }
        session.selection = { ...session.selection, sessionKey: to }
        session.meta.sessionKey = to
        moved = true
      }
      return moved
    },

    // The host's registered LocalTools (for role-permission editors). Resolves
    // a dynamic tools source (e.g. live agent-tool graph nodes) same as a turn
    // would. Per-session MCP and skill tools are separate and not listed here.
    //
    // No caller, deliberately: this lists the registry for an editor deciding
    // what a ROLE may reach, which is a question about the tools, not about
    // anyone calling them. A caller's identity changes what a tool does when
    // invoked; it must not change whether the tool can be granted, or an
    // identity-gated tool would be missing from the very screen that governs
    // it (see ToolsCaller — a factory returns its full toolset for an empty
    // caller).
    async listTools(): Promise<{ name: string; description: string }[]> {
      const tools = options.tools ?? []
      const resolved = typeof tools === 'function' ? await tools({}) : tools
      return resolved.map((tool) => ({ name: tool.name, description: tool.description }))
    },

    async createSession(
      selection: AgentSelection,
      defaultModeId?: string,
      permissions?: ResolvedPermissions,
    ): Promise<SessionMeta> {
      const connection = await ensureConnection(selection)
      const native = isNativeSelection(selection)
      // ACP: mint a token before newSession so the built-in MCP server can apply
      // this session's permissions on the very first tools/list. Tagged onto the
      // internal entry only.
      let token: string | null = null
      let mcpServers: AcpMcpServer[] = []
      if (!native && supportsTools(selection)) {
        const { internal, servers } = await buildMcpServers(selection)
        token = randomUUID()
        store.acpTokenPermissions.set(token, permissions)
        mcpServers = tagInternal(internal, servers, token)
      }
      const response = await connection.newSession({
        cwd: selection.cwd,
        mcpServers,
        _meta: sessionMeta(selection),
      })
      const sessionId = response.sessionId
      if (token) {
        store.acpTokenSession.set(token, sessionId)
      }
      if (native) {
        // Native sessions carry their permissions on the shared session record.
        const nativeSession = store.nativeSessions.get(sessionId)
        if (nativeSession) {
          nativeSession.permissions = permissions
        }
      }
      store.titleCounter += 1
      const now = Date.now()
      const meta: SessionMeta = {
        id: sessionId,
        title: `New chat ${store.titleCounter}`,
        createdAt: now,
        lastActivityAt: now,
        canFork: native,
        sessionKey: selection.sessionKey,
      }
      store.sessions.set(sessionId, {
        meta,
        selection,
        events: [],
        subscribers: new Set(),
        modes: response.modes ? toSessionModes(response.modes) : null,
        configOptions: response.configOptions ?? [],
        commands: [],
        permissions,
        activeTurns: 0,
        queue: [],
        presence: DEFAULT_PRESENCE,
      })
      // A session opened under a key that was holding messages when the last
      // process stopped takes them back, at the cadence it was reading at,
      // before it can be sent anything new.
      await restoreSessionState(sessionId)
      if (response.modes) {
        emitSessionModes(sessionId)
      }
      if (response.configOptions) {
        emitConfigOptions(sessionId)
      }
      // Apply the requested initial approval mode, when offered.
      if (
        defaultModeId &&
        response.modes &&
        response.modes.currentModeId !== defaultModeId &&
        response.modes.availableModes.some((mode) => mode.id === defaultModeId)
      ) {
        await connection
          .setSessionMode({ sessionId, modeId: defaultModeId })
          .then(() => {
            const session = store.sessions.get(sessionId)
            if (session?.modes) {
              session.modes.current = defaultModeId
            }
            emit(sessionId, { kind: 'mode_changed', current: defaultModeId })
          })
          .catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
      }
      // Apply the reasoning preference to ACP agents that expose a thought_level
      // config option (the native harness handles reasoning via providerOptions).
      const effort = resolveReasoningEffort(selection)
      if (!native && effort && response.configOptions) {
        const option = response.configOptions.find(
          (entry) => entry.category === 'thought_level' && entry.type === 'select',
        )
        const value = option && option.type === 'select' ? matchReasoningValue(option.options, effort) : undefined
        if (option && value) {
          await this.setConfigOption(sessionId, option.id, value).catch((error: unknown) =>
            emit(sessionId, { kind: 'error', message: errorMessage(error) }),
          )
        }
      }
      return meta
    },

    // Resume a persisted ACP session by replaying its recorded history
    // (session/load). Returns null when the session can't be resumed this way —
    // a native selection (no on-disk history) or an agent that doesn't advertise
    // `loadSession` — so callers fall back to a fresh session. The agent owns its
    // transcript, so this stays harness-agnostic: we never read its session files.
    async loadSession(
      sessionId: string,
      selection: AgentSelection,
      permissions?: ResolvedPermissions,
    ): Promise<SessionMeta | null> {
      if (isNativeSelection(selection)) {
        return null
      }
      const connection = await ensureConnection(selection)
      const entry = connEntryFor(selection)
      if (!entry?.loadSession) {
        return null
      }
      // Mint a per-session MCP token before the replay, mirroring createSession.
      let token: string | null = null
      let mcpServers: AcpMcpServer[] = []
      if (supportsTools(selection)) {
        const { internal, servers } = await buildMcpServers(selection)
        token = randomUUID()
        store.acpTokenPermissions.set(token, permissions)
        store.acpTokenSession.set(token, sessionId)
        mcpServers = tagInternal(internal, servers, token)
      }
      store.titleCounter += 1
      const loadedAt = Date.now()
      const meta: SessionMeta = {
        id: sessionId,
        title: `New chat ${store.titleCounter}`,
        createdAt: loadedAt,
        lastActivityAt: loadedAt,
        canFork: false,
        sessionKey: selection.sessionKey,
      }
      // Register the session record BEFORE the replay: the agent streams its
      // history as session/update notifications, and emit()/subscribe() drop
      // events for an unknown session id.
      store.sessions.set(sessionId, {
        meta,
        selection,
        events: [],
        subscribers: new Set(),
        modes: null,
        configOptions: [],
        commands: [],
        permissions,
        activeTurns: 0,
        queue: [],
        presence: DEFAULT_PRESENCE,
        // Replay notifications land via handleUpdate while the call below is
        // pending; this is what tells it to reconstruct the turn boundaries the
        // replay omits.
        replaying: true,
      })
      try {
        const response = await connection.loadSession({
          sessionId,
          cwd: selection.cwd,
          mcpServers,
          _meta: sessionMeta(selection),
        })
        // Seed from the response the same way newSession does — the agent may
        // not replay a config_option_update for state it already had before
        // this load, so relying on replay alone can leave configOptions empty.
        // Replay notifications land via handleUpdate while this call is
        // pending, i.e. strictly before this response resolves, so a replayed
        // update is the newer state — only fall back to this "initial"
        // snapshot when nothing was replayed, rather than overwriting it.
        if (response.configOptions) {
          const session = store.sessions.get(sessionId)
          if (session && session.configOptions.length === 0) {
            session.configOptions = response.configOptions
            emitConfigOptions(sessionId)
          }
        }
      } catch (error) {
        // Transcript gone or agent refused — unwind the half-registered session
        // so the caller can cleanly create a fresh one.
        store.sessions.delete(sessionId)
        if (token) {
          store.acpTokenSession.delete(token)
          store.acpTokenPermissions.delete(token)
        }
        throw error
      }
      const loaded = store.sessions.get(sessionId)
      if (loaded) {
        loaded.replaying = false
      }
      // After the replay, not before it: restoring mid-replay would let a
      // drain deliver into a session that is still reconstructing its own
      // history, and the queue snapshot would be published against a
      // half-built transcript.
      await restoreSessionState(sessionId)
      // The replay streams history but no turn boundary, so the client would stay
      // stuck "waiting". A terminal turn_end marks the resumed session idle.
      //
      // This one closes the LAST replayed turn, and unlike the earlier
      // boundaries its marker is inferred rather than known. The replay records
      // no more about how this turn ended than about any other, so nothing can
      // identify a severed turn with certainty — but the tail of the transcript
      // is evidence. A replay that ends on settled work (see endsOnSettledWork)
      // shows a turn that finished and a session that then went quiet:
      // `replayed`, reported as unknown like its neighbours. One that ends
      // mid-step is the shape of a turn cut off: `resumed`, reported as
      // interrupted.
      //
      // It is a heuristic. It can call a severed turn `unknown` when the agent
      // had already finished a step before it died, which is the honest
      // direction to be wrong in: an unconditional `resumed` reports every idle
      // restart's newest turn as cut off, which is a confident claim and false
      // more often than not.
      const tail = loaded ? lastConversationEvent(loaded.events) : undefined
      emit(sessionId, { kind: 'turn_end', stopReason: endsOnSettledWork(tail) ? 'replayed' : 'resumed' })
      return meta
    },

    async resumeSession(sessionId: string): Promise<void> {
      await performResumeSession(sessionId)
    },

    // Applies the current global MCP server list to every live session.
    // A session with a turn in flight is left alone — resuming it now would
    // send session/resume over the same connection its live prompt is
    // streaming on, which is what used to cut turns off mid-flight. It's
    // marked pendingMcpRefresh instead, and settleTurn applies the resume the
    // moment that turn actually ends, so the list is still applied — just not
    // at the cost of interrupting whatever the session was doing.
    async refreshMcpServers(): Promise<void> {
      for (const [sessionId, session] of store.sessions) {
        if (session.activeTurns > 0) {
          session.pendingMcpRefresh = true
          continue
        }
        await performResumeSession(sessionId).catch((error: unknown) =>
          emit(sessionId, { kind: 'error', message: errorMessage(error) }),
        )
      }
    },

    // Read side of setMode: what this session offers, what it is on, and which
    // adapter it runs — the three things needed to reason about a mode without
    // reaching into session state. `adapterId` is included because a mode id is
    // only meaningful against the adapter that advertised it (see
    // session-modes.ts). Null for an unknown session, or one whose agent
    // advertises no modes at all.
    sessionModes(sessionId: string): { adapterId: string; available: SessionMode[]; current: string } | null {
      const session = store.sessions.get(sessionId)
      if (!session?.modes) {
        return null
      }
      return {
        adapterId: session.selection.adapterId,
        available: session.modes.available,
        current: session.modes.current,
      }
    },

    async setMode(sessionId: string, modeId: string): Promise<void> {
      const connection = await connectionForSession(sessionId)
      await connection.setSessionMode({ sessionId, modeId })
      const session = store.sessions.get(sessionId)
      if (session?.modes) {
        session.modes.current = modeId
      }
      emit(sessionId, { kind: 'mode_changed', current: modeId })
    },

    // Change a dynamic session config option (mode/model/thought_level/etc.)
    // and reconcile state from the response. The agent may also push the same
    // change back as a config_option_update notification (handled in
    // handleUpdate) — both paths write the same "last update wins" state, so
    // whichever arrives is harmless to apply twice.
    async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
      const connection = await connectionForSession(sessionId)
      const session = store.sessions.get(sessionId)
      const option = session?.configOptions.find((entry) => entry.id === configId)
      const request =
        option?.type === 'boolean'
          ? { sessionId, configId, type: 'boolean' as const, value: Boolean(value) }
          : { sessionId, configId, value: String(value) }
      const response = await connection.setSessionConfigOption(request)
      if (session) {
        session.configOptions = response.configOptions
      }
      emit(sessionId, { kind: 'config_options', options: response.configOptions })
    },

    // Ends the session on the agent side before dropping our own state, so its
    // subprocess doesn't outlive the chat.
    // `store.connections` is keyed by spawn config, not sessionId — a
    // subprocess/connection is shared by every session on the same agent+job
    // — so this is deliberately session-scoped first: graceful
    // `closeSession` asks the agent to free just this one session, and only
    // when that isn't possible AND no sibling session still uses the
    // connection do we fall back to killing the whole subprocess.
    async deleteSession(sessionId: string): Promise<void> {
      const session = store.sessions.get(sessionId)
      // A deleted session's pending read has nothing left to deliver into, and
      // a timer holding a reference to it would keep the record alive.
      if (session) {
        clearPresenceTimer(session)
      }
      // The durable queue is deliberately NOT cleared here. This drops the live
      // session record, which a host also does to stop an agent's process while
      // keeping the conversation — and clearing there would discard everything
      // queued for a session that is about to be reopened, which is the exact
      // loss the durable queue exists to prevent. Only the host knows which
      // deletion is final, so `clear` is the host's call. See QueueStore.
      if (session && !isNativeSelection(session.selection)) {
        const key = spawnKey(buildSpawnConfig(session.selection))
        const entry = store.connections.get(key)
        if (entry) {
          let closed = false
          try {
            await entry.connection.closeSession({ sessionId })
            closed = true
          } catch {
            // The agent may not support session.close, the session may never
            // have reached this connection, or the subprocess may already be
            // gone — deletion must not be blocked on any of that.
          }
          if (!closed) {
            const hasSibling = [...store.sessions.values()].some(
              (other) =>
                other !== session &&
                !isNativeSelection(other.selection) &&
                spawnKey(buildSpawnConfig(other.selection)) === key,
            )
            if (!hasSibling) {
              entry.process?.kill()
              store.connections.delete(key)
            } else {
              console.warn(
                `[agent-client] deleteSession(${sessionId}): closeSession failed and a sibling session still shares connection ${key} — subprocess left running.`,
              )
            }
          }
        }
      }
      store.sessions.delete(sessionId)
      store.nativeSessions.delete(sessionId)
      dropSessionTokens(sessionId)
      if (store.lastSessionId === sessionId) {
        store.lastSessionId = null
      }
    },

    /**
     * A user turn as it was DELIVERED — tags, interrupt note and all — named
     * by its absolute position in this session's event log, together with the
     * turn ordinal that addresses the same turn for `forkSession`.
     *
     * Both, from one read, because they must agree. The event index is what a
     * client can name safely: a chat opens on a bounded tail of its history,
     * so a count of user turns means different turns on the two sides and an
     * edit keyed that way lands on whichever message they happened to disagree
     * about. The ordinal is what the rewind takes. Deriving one from the other
     * anywhere else would be two derivations to keep in step.
     *
     * The text has to be read here, server-side, rather than sent up by
     * whoever is editing: the tags carry authorship, and a surface that
     * supplies them is a surface that can forge them (see this app's
     * `WirePromptOrigin`, which exists to make that impossible for an ordinary
     * send). The browser sends words; who said them comes from this.
     *
     * Null when the session is gone, the index is out of range, or the event
     * there is not a user turn. Nothing is clamped or nearest-matched: an edit
     * aimed at a turn that is no longer where it was would otherwise come back
     * with a DIFFERENT turn's words and metadata, and commit the reader's edit
     * against somebody else's message.
     *
     * NOTE for hosts with a `transformDeliveredPrompt`: what comes back is the
     * TRANSFORMED text, because that is what was delivered and what the
     * transcript replays. A host that re-delivers it is transforming it twice,
     * so a transform that prepends (a timestamp, an envelope) needs its own
     * inverse applied first — see this app's `stripDeliveryStamp`.
     */
    userTurnAt(sessionId: string, eventIndex: number): { text: string; turnIndex: number } | null {
      const session = store.sessions.get(sessionId)
      const event = session?.events[eventIndex]
      if (!session || !event || event.kind !== 'user') {
        return null
      }
      // The ordinal is how many user turns precede this one, which is exactly
      // what findTurnBoundary's own index means.
      let turnIndex = 0
      for (let i = 0; i < eventIndex; i += 1) {
        if (session.events[i].kind === 'user') {
          turnIndex += 1
        }
      }
      return { text: event.text, turnIndex }
    },

    // Branch a session into a new one, rewound to a turn (dropFromTurn, 0-based;
    // defaults to the last turn). Only the native harness can do this (we own its
    // message store); ACP fork copies the whole session with no cutoff, so it's
    // rejected here.
    async forkSession(sessionId: string, dropFromTurn?: number): Promise<SessionMeta | null> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return null
      }
      if (!isNativeSelection(session.selection)) {
        throw new Error('Forking is only supported by the in-process native harness.')
      }
      const connection = await ensureConnection(session.selection)
      const response = await connection.unstable_forkSession({
        sessionId,
        cwd: session.selection.cwd,
        mcpServers: [],
        _meta: dropFromTurn === undefined ? undefined : { dropFromTurn },
      })
      // Trim our event log at the same boundary the harness trims its messages —
      // drop from the chosen user turn's event — so the fork's replayed transcript
      // matches its model history. With no prior turn, keep the leading modes event.
      const userEvents: number[] = []
      session.events.forEach((event, index) => {
        if (event.kind === 'user') {
          userEvents.push(index)
        }
      })
      const boundary = findTurnBoundary(userEvents, dropFromTurn)
      // The fork starts idle with an empty queue, so the source session's
      // 'queue' snapshots must not carry over — replaying one would resurrect
      // queue state the fork doesn't actually hold.
      const forkedEvents = (
        boundary === null ? session.events.filter((event) => event.kind === 'modes') : session.events.slice(0, boundary)
      ).filter((event) => event.kind !== 'queue')
      const forkedAt = Date.now()
      const meta: SessionMeta = {
        id: response.sessionId,
        title: `${session.meta.title} (fork)`,
        createdAt: forkedAt,
        lastActivityAt: forkedAt,
        profileId: session.meta.profileId,
        canFork: true,
        // Deliberately not inherited from the source session: a fork is reached
        // through its own tab, never through the original sessionKey (see
        // forkLocal in acp.ts), so carrying the key forward would make a
        // sessionKey -> session lookup ambiguous between the two.
      }
      store.sessions.set(response.sessionId, {
        meta,
        selection: session.selection,
        events: forkedEvents,
        subscribers: new Set(),
        modes: response.modes ? toSessionModes(response.modes) : session.modes,
        // Shares the source session's array reference — safe because every
        // write path (config_option_update, setConfigOption, the loadSession
        // seed above) replaces it wholesale rather than mutating in place.
        configOptions: session.configOptions,
        // Same wholesale-replacement contract as configOptions.
        commands: session.commands,
        permissions: session.permissions,
        activeTurns: 0,
        queue: [],
        // Inherited: a fork continues the same conversation, and a reader who
        // set this session to hourly did not ask to be read in realtime because
        // they branched it.
        presence: session.presence,
      })
      return meta
    },

    // How this message relates to the queue, stated by every caller rather than
    // defaulted — the whole point of the parameter is that sending into a busy
    // session stops being a guess.
    //
    // `wait`: held until the turn ends, delivered on its own. Note it is the
    // MESSAGE that waits, never the caller — this resolves as soon as the
    // message is safely held.
    //
    // `push`: interrupt whatever is running and deliver everything held,
    // together with this message and this message last, as ONE turn. The
    // interrupt lives HERE rather than at each call site: "push" is a single
    // idea, and a surface that had to remember to cancel first before prompting
    // would be a second copy of the semantics waiting to drift. Callers that
    // need to report whether anything was actually interrupted read it off the
    // return value instead of probing the session themselves.
    //
    // Against an empty queue the two are the same ordinary send: there is
    // nothing held to hand over and so nothing to interrupt for.
    async prompt(
      sessionId: string,
      text: string,
      opts: { front?: boolean; queue: QueueMode; origin: PromptOrigin },
    ): Promise<{ interrupted: boolean }> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return { interrupted: false }
      }
      // Session records that survived a dev hot-reload may predate the queue
      // fields (the store outlives createStore); backfill in place.
      session.queue ??= []
      session.activeTurns ??= 0

      // Steering-capable agents never queue: the prompt goes straight through
      // and the live turn picks it up as streaming input, so there is nothing to
      // batch and nothing worth interrupting.
      const holding = session.activeTurns > 0 && !supportsMidTurnInput(session.selection)
      // Read once per call, next to the turn guard it modifies: while the host
      // holds delivery, an interrupt buys nothing (the drain it exists to
      // trigger is gated), so `push` must not end the running turn.
      const deliveryHeld = options.shouldHoldDelivery?.() === true

      // High Attention decides the mode itself: everything sent while that
      // cadence is set goes now, with a stop for whatever turn is running. The
      // sender does not opt in — `queue` is the sender's word about one message,
      // a cadence is the reader's standing word about all of them, and the
      // standing word wins.
      const mode: QueueMode = session.presence.kind === 'high-attention' ? 'push' : opts.queue
      // And which interrupt note a delivery it buys would open with: the
      // compact per-interrupt wording under High Attention, where stopping is
      // how messages routinely arrive, the queue-jump wording for a one-off
      // push.
      const noteKind: DeliveryNote = session.presence.kind === 'high-attention' ? 'interrupt' : 'queue-jump'

      const entry = toEntry(text, opts.origin)
      if (!entry) {
        // Nothing of its own to send. For `wait` that is simply nothing: an
        // empty prompt would start a turn saying nothing.
        //
        // For a `push` it is the "send what is already held, now" case — a
        // caller with nothing to add that still wants what is waiting to go. So
        // it interrupts, because there is something to hand over instead. With
        // nothing held there is nothing to deliver, and ending a turn to say
        // nothing is never what a caller meant.
        if (mode !== 'push' || session.queue.length === 0) {
          return { interrupted: false }
        }
        // A push means now, whatever the reading cadence says. The note is
        // marked for both paths from here: this caller is typically the
        // Unread heading's deliver button with nothing of its own to add, and
        // the delivery it buys -- held messages leaving ahead of the cadence
        // -- is exactly what the queue-jump wording exists to say. Marked
        // before the drain/cancel for the same reason the message-push path
        // marks before its interrupt: the note is consumed by the first
        // message delivery (see dispatchRun), so it rides a drain, and an
        // empty queue never reaches this line to leave one behind.
        session.bypassPresenceOnce = true
        if (holding && deliveryHeld) {
          // Degrades to waiting: the held run goes when the gate reopens, no
          // turn is cancelled, and no queue-jump note is left claiming a jump
          // that never happened. The presence bypass above still stands -- the
          // sender's "now" survives as "as soon as delivery resumes".
          return { interrupted: false }
        }
        session.nextDeliveryNote = noteKind
        if (!holding) {
          await drainQueue(sessionId)
          return { interrupted: false }
        }
        await cancelSession(sessionId)
        return { interrupted: true }
      }

      // `front` puts a message ahead of what is already held — corrective
      // guidance after a rejected permission, which must reach the agent before
      // anything else. It is a position within the queue, not a decision about
      // interrupting.
      //
      // It is ignored under `push`, which promises the opposite in as many
      // words: everything held, this message LAST. That promise is written in
      // QueueMode, in the tool descriptions and in the node manifest, so
      // honouring `front` here would silently invert an order three documented
      // surfaces state. Ignored rather than trusted not to be passed. High
      // Attention runs every message as a push, so the same applies there.
      const placement = opts.front && mode !== 'push' ? 'front' : 'end'
      if (placement === 'front') {
        session.queue.unshift(entry)
        // Jumping the line means jumping the reading window too. `front` is the
        // corrective guidance sent after a rejected permission: the turn it
        // belongs to has already been cancelled, so holding it for the cadence
        // leaves the agent stopped and the reader's answer undelivered for as
        // long as the window lasts. A position in the queue it can never reach
        // in time is not a position at all.
        //
        // Scoped to a MESSAGE deliberately. A system entry also goes in front —
        // the standing-context restore does — and system entries are never
        // presence-gated in the first place, so a bypass granted there would
        // spend nothing and sit unspent until some later message run consumed
        // it and skipped a window nobody asked to skip.
        if (entry.kind === 'message') {
          session.bypassPresenceOnce = true
        }
      } else {
        session.queue.push(entry)
      }
      // After the in-memory queue, never before it: the message is already safe
      // to deliver, and the durable copy is catching up.
      persist(session, (store, key) => store.append(key, entry, placement))
      // Announced only when it will actually WAIT — and only for the case that
      // is knowable here, a turn already running. Whether the READING WINDOW
      // will hold it is the drain's answer, so that announcement is made there.
      // A send that passes straight through was never held, and saying
      // otherwise would put every ordinary message through the Unread list on
      // its way out.
      if (holding) {
        emitQueue(sessionId, session.queue)
      }

      if (mode !== 'push') {
        // `wait`: held until the turn ends, or until Presence opens the window.
        // If nothing is running, it goes now.
        if (!holding) {
          await drainQueue(sessionId)
        }
        return { interrupted: false }
      }

      // `push`: interrupt, and let the drain that follows take the whole leading
      // run. MARK BEFORE INTERRUPTING — cancelling a real agent ends its turn
      // inside the await below, so a drain can run while this call is still
      // suspended. Setting the note afterwards was the race that once shipped a
      // stale message on its own; the ordering is the fix, not a narrower
      // window.
      // A push means now, whatever the reading cadence says. Set for the idle
      // path too: nothing was interrupted there, but the caller still asked for
      // this to go rather than to wait for a window.
      session.bypassPresenceOnce = true
      if (!holding) {
        await drainQueue(sessionId)
        return { interrupted: false }
      }
      if (deliveryHeld) {
        // Same degradation as the empty-push branch above: the message is
        // already enqueued and durable, and interrupting the live turn would
        // end it without delivering anything sooner.
        return { interrupted: false }
      }
      session.nextDeliveryNote = noteKind
      await cancelSession(sessionId)
      return { interrupted: true }
    },

    /**
     * Set how often this session's agent reads its queue.
     *
     * Applied to what is ALREADY waiting, not only to what arrives next: a
     * reader who switches an hourly session to realtime is asking for the
     * message they can see sitting there, and telling them to send another one
     * to shake it loose would be absurd. So the pending wait is re-evaluated
     * immediately — which delivers now if the new window has already elapsed,
     * and otherwise re-arms against the new one.
     */
    setPresence(sessionId: string, presence: Presence): void {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return
      }
      session.presence = presence
      // The old window belonged to the old cadence; the next check rolls one
      // for the new one. Clearing the timer with it is what stops the previous
      // deadline firing against a setting nobody holds any more.
      clearPresenceTimer(session)
      emit(sessionId, { kind: 'presence', presence })
      // Only when nothing is running: a turn in flight has its own drain coming
      // at the boundary, and starting a second delivery underneath it is the
      // thing the turn guard exists to prevent.
      if (session.activeTurns === 0) {
        void drainQueue(sessionId)
      }
    },

    // Drop a still-queued prompt before it's delivered. Unknown ids are a
    // no-op — the message may have just been shifted out for delivery.
    removeQueued(sessionId: string, id: string): void {
      const session = store.sessions.get(sessionId)
      if (!session?.queue?.some((item) => item.id === id)) {
        return
      }
      session.queue = session.queue.filter((item) => item.id !== id)
      emitQueue(sessionId, session.queue)
      // A reader who took a message back means it: it must not come back at the
      // next restart.
      persist(session, (store, key) => store.remove(key, [id]))
    },

    /**
     * What the reader's Stop means, decided here rather than by the caller.
     *
     * Stopping with unread messages held is usually a CORRECTION, not an
     * abandonment: the reader has written something the agent has not seen and
     * wants it to act on that instead. So the turn is cancelled AND everything
     * held goes at once — the same mark-then-interrupt shape a `push` uses, so a
     * drain landing inside the cancel takes the whole leading run rather than
     * one stale entry. Presence is bypassed for the same reason a push bypasses
     * it: a person asking for attention now is not waiting for a window.
     *
     * With nothing held it is an ordinary cancel and nothing is delivered.
     *
     * The queue is read HERE, not in the caller, because the caller's view of
     * it is a render old: a message arriving between the paint and the click
     * would otherwise get an ordinary stop and stay unread, which is precisely
     * the case this feature exists for. Deciding it next to the queue makes
     * that unobservable rather than unlikely.
     *
     * Distinct from `prompt(..., { queue: 'push' })` with empty text in exactly
     * one way, and deliberately: a push with nothing to deliver interrupts
     * nothing, because ending a turn to say nothing is never what a caller
     * meant. A Stop with nothing to deliver still stops — that IS what the
     * reader meant.
     */
    async stop(sessionId: string): Promise<{ delivered: number }> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return { delivered: 0 }
      }
      session.queue ??= []
      // "Unread" means messages. A queue holding only system entries has nothing
      // the reader wrote and has not been seen, so a stop there is a plain stop —
      // the same rule the Unread section renders by.
      const unread = session.queue.filter((entry) => entry.kind === 'message').length
      if (unread > 0) {
        // Marked before the cancel, so the delivery the interrupt buys carries
        // the note however soon the settle lands. The queue-jump wording: a
        // Stop is a one-off ask for attention now, not the cadence talking.
        session.nextDeliveryNote = 'queue-jump'
        // And skips the reading window: a person who pressed Stop with
        // something unsaid is asking to be read now, not at the hour.
        session.bypassPresenceOnce = true
      }
      await cancelSession(sessionId)
      return { delivered: unread }
    },

    resolvePermission(requestId: string, optionId?: string): void {
      const pending = store.pendingPermissions.get(requestId)
      if (!pending) {
        return
      }
      store.pendingPermissions.delete(requestId)
      pending.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
      emit(pending.sessionId, {
        kind: 'permission_resolved',
        requestId,
        optionId,
      })
    },

    // `answer` shapes, matching the three ways an ask renders:
    // - an object — a form elicitation's content, keyed by the schema's own
    //   property names (the agent validates it against the schema it sent).
    //   An EMPTY object is a real answer: accept with nothing to say, which is
    //   how a URL ask's "Done" reads.
    // - a non-empty string — the free-text prompt's reply, delivered under the
    //   `answer` key it has always used;
    // - undefined or '' — cancel, exactly as before this took objects.
    resolveElicitation(requestId: string, answer?: string | Record<string, ElicitationContentValue>): void {
      const pending = store.pendingElicitations.get(requestId)
      if (!pending) {
        return
      }
      store.pendingElicitations.delete(requestId)
      if (answer !== undefined && typeof answer !== 'string') {
        pending.resolve({ action: 'accept', content: answer })
      } else {
        pending.resolve(answer ? { action: 'accept', content: { answer } } : { action: 'cancel' })
      }
      emit(pending.sessionId, { kind: 'ask_user_resolved', requestId })
    },

    /**
     * Raise a question in a session's chat FROM THE HOST — the same pending
     * entry and the same `ask_user` event an agent-sent ACP elicitation gets,
     * so it renders and resolves identically. What differs is only who is
     * waiting: an agent elicitation resolves a protocol response back over the
     * connection, while this resolves the host caller (a session-scoped tool
     * like ask_user) with the accepted content, or null when the reader
     * dismissed it or the session is unknown.
     */
    askUser(
      sessionId: string,
      params: { message: string; form?: ElicitationSchema },
    ): Promise<Record<string, ElicitationContentValue> | null> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return Promise.resolve(null)
      }
      return new Promise((resolveContent) => {
        const requestId = randomUUID()
        store.pendingElicitations.set(requestId, {
          sessionId,
          // Adapts the protocol-response shape the shared resolve path speaks
          // (resolveElicitation builds it) to the host caller's answer.
          resolve: (response) =>
            resolveContent(
              response.action === 'accept'
                ? ((response as { content?: Record<string, ElicitationContentValue> | null }).content ?? {})
                : null,
            ),
        })
        emit(sessionId, {
          kind: 'ask_user',
          requestId,
          message: params.message,
          ...(params.form ? { form: params.form } : {}),
        })
      })
    },

    async cancel(sessionId: string): Promise<void> {
      await cancelSession(sessionId)
    },

    // `opts.fromIndex` bounds the replayed history to `session.events` starting
    // at that absolute index (omit, or 0, for the full log — existing
    // behavior). Live events (pushed after this call) are never bounded; only
    // the replay-on-connect portion is. See getEventsWindow for computing a
    // tail or older-page fromIndex to pass here.
    subscribe(sessionId: string, subscriber: Subscriber, opts?: { fromIndex?: number }): () => void {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return () => {}
      }
      const from = opts?.fromIndex ?? 0
      const windowed = from > 0 ? session.events.slice(from) : session.events
      for (const event of withSnapshotPrefix(session, windowed)) {
        subscriber(event)
      }
      session.subscribers.add(subscriber)
      return () => {
        session.subscribers.delete(subscriber)
      }
    },

    // A bounded slice of a session's event log, cut at user-turn boundaries
    // (never mid-turn — see pagination.ts). Omit `beforeIndex` for the TAIL
    // (the most recent `turns` turns — what a cold-opened chat should show
    // first); pass a previous window's `startIndex` back as `beforeIndex` to
    // page further back (a scroll-up "load older"). Returns null for an
    // unknown session.
    //
    // Turn granularity is for callers that are actually listing turns — the
    // send-message node's listTurns action. The chat transcript pages by
    // records instead; see getRecordsWindow.
    getEventsWindow(sessionId: string, opts: { beforeIndex?: number; turns: number }): EventsWindow | null {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return null
      }
      return opts.beforeIndex === undefined
        ? tailByTurns(session.events, opts.turns)
        : pageBeforeByTurns(session.events, opts.beforeIndex, opts.turns)
    },

    // The chat transcript's only cursor: a window of `records` AGENT records,
    // cut at record boundaries so a tool call is never separated from its
    // updates. Omit `beforeIndex` for the tail a cold open shows; pass a
    // previous window's `startIndex` back to page further up.
    //
    // A turn's `user` event is free — it never spends budget, and when the
    // window starts mid-turn the enclosing one comes back as `header` rather
    // than inside `events`. See pagination.ts's RecordsWindow for why it is
    // separate. Returns null for an unknown session.
    getRecordsWindow(sessionId: string, opts: { beforeIndex?: number; records: number }): RecordsWindow | null {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return null
      }
      return opts.beforeIndex === undefined
        ? tailByRecords(session.events, opts.records)
        : pageBeforeByRecords(session.events, opts.beforeIndex, opts.records)
    },

    async reset(): Promise<void> {
      for (const entry of store.connections.values()) {
        entry.process?.kill()
      }
      store.connections.clear()
      store.sessions.clear()
      store.nativeSessions.clear()
      store.pendingPermissions.clear()
      store.pendingElicitations.clear()
      store.acpTokenPermissions.clear()
      store.acpTokenSession.clear()
      store.lastSessionId = null
      await mcp.close()
    },
  }
}

export const agentClient = createAgentClient({
  skills: fileSkills,
  skillHandler: fileSkillHandler,
})
