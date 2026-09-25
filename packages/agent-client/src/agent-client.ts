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
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Stream } from '@agentclientprotocol/sdk'

import { type AttachmentRef, type DeliveredAttachment, isImageMime, type PromptAttachment } from './attachments'
import { type ChatMessageRecord, toChatMessages } from './chat-completion'
import type { AgentConnection } from './connection'
import { normalizeUsage } from './context-window'
import { errorMessage } from './errors'
import { isTerminalToolStatus, lastConversationEvent } from './fold'
import { type HarnessFailure, harnessStartError } from './harness-failure'
import { readMcpConfig, resolveMcpServers } from './mcp-config'
import { createMcpServer, type SkillHandler, type SkillsInput, type ToolsInput } from './mcp-server'
import type { McpServerConfig } from './mcp-types'
import { containerReachableMcpUrl } from './mcp-url'
import {
  createNativeHarness,
  NATIVE_PROMPT_CAPABILITIES,
  type NativeHarnessConfig,
  type NativeSession,
} from './native-harness'
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
import { buildSpawnConfig, findAdapter, isNativeSelection } from './resolve'
import { foldRestoredState, restorableEvents } from './session-restore'
import { fileSkillHandler, fileSkills } from './skills'
import { findTurnBoundary } from './turns'
import type {
  AgentSelection,
  AsyncTaskInfo,
  AvailableCommand,
  ChatEvent,
  CompactionState,
  PlanItem,
  Presence,
  PromptOrigin,
  QueuedPrompt,
  QueueMode,
  RateLimitWindow,
  SessionCost,
  SessionFailure,
  SessionMeta,
  SessionMode,
  SessionUsage,
  SpawnConfig,
  SubagentInfo,
  TurnQuota,
  TurnTokenUsage,
} from './types'
import { mergeRateLimit, normalizeTurnUsage, parseRateLimit, parseSessionFailure, parseTurnQuota } from './usage-meta'

export interface ClientInfo {
  name: string
  version: string
}

// The permission contract a host implements lives in its own module, so that
// reading a request into it is testable without an agent on the other end.
export type { PermissionContext, PermissionHandler, PermissionOutcome } from './permission-context'

/** An attachment as a prompt is handed one: positioned or not (see prompt()). */
export type PromptAttachmentInput = AttachmentRef & { message?: number }

export interface AgentClientOptions {
  mcpServerName?: string
  // Resolve the attachments a delivery carries (see attachments.ts) into the
  // bytes an ACP image block holds. Host-provided, because an attachment is an
  // id in the HOST's store — this engine keeps none, and a message can be
  // delivered long after it was written.
  //
  // The session key travels with the ids so the host can scope the lookup: an
  // id from another conversation must resolve to nothing rather than to its
  // bytes, whoever put it on the prompt. Undefined for a session created
  // without a key.
  //
  // Absent means a host with no attachment store: a prompt's attachments are
  // then reported as not having travelled, and the text goes alone.
  loadAttachments?: (request: {
    sessionKey?: string
    ids: readonly string[]
  }) => Promise<readonly PromptAttachment[]>
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
  //
  // `sessionKey` is the session's external key (selection.sessionKey), passed
  // because a host storing anything per conversation has to file it under the
  // name that survives a restart — a session id does not. Without it the hook
  // would have to look the key up on every chunk of every stream, which is a
  // scan of the whole registry per event.
  onEvent?: (sessionId: string, event: ChatEvent, sessionKey?: string) => void
  // Notified on every LIVE status transition of a context compaction — once
  // per status a compaction entity reaches, with its full merged state, and
  // never during a session/load history replay (a replayed `completed` is old
  // news, and a host reacting to it — e.g. re-sending standing context — would
  // fire again on every resume). Same isolation contract as onEvent: called in
  // a try/catch, return value ignored, never drives the engine. A host that
  // re-delivers dropped instructions after compaction hooks the `completed`
  // transition here — that covers the harness's own auto-compaction and a
  // user-typed `/compact` alike, not just compactions the host itself started.
  onCompaction?: (sessionId: string, compaction: CompactionState) => void
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
  //
  // Host notifications (see `notify`) are held by it too, and here the hold
  // includes steering: an injection starts no turn, but it is still a
  // hand-over, and "nothing is handed to any agent" is what the gate means.
  // resumeDelivery() delivers them alongside the queue, ahead of it.
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
  /**
   * Stop a background task the HOST runs on a session's behalf — one it
   * reported through `upsertAsyncTask`, which records it with `origin: 'host'`.
   *
   * `stopAsyncTask` routes on that origin. A task the harness reported is
   * stopped over `_session/async_task/stop`, as it always was; a host task
   * never is, because the harness has never heard of it — the request would
   * go out, be answered, and stop nothing. So the stop goes back to whoever
   * started the work.
   *
   * Resolves whether the task was stopped. The task's new state is not
   * inferred from that answer: the host reports it through `upsertAsyncTask`
   * like every other transition, so what the reader sees is always what the
   * host says happened. `sessionKey` rides along because a host files its
   * work under the name that survives a restart, which a session id does not.
   *
   * Absent means a host that runs no background work of its own: stopping a
   * host task then resolves false.
   */
  stopHostTask?: (request: { sessionId: string; sessionKey?: string; asyncTaskId: string }) => Promise<boolean>
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

/**
 * One notification the host issued through `notify`, waiting to be handed to
 * the harness, with the settle of the promise its caller holds. The caller has
 * to learn whether the text arrived — it tries again on false — so the entry
 * carries that answer's only way out.
 */
interface HeldNotification {
  text: string
  settle: (handedOver: boolean) => void
}

interface SessionState {
  meta: SessionMeta
  // The resolved selection is kept in memory so the engine can reconnect /
  // resume without any on-disk profile store.
  selection: AgentSelection
  events: ChatEvent[]
  subscribers: Set<Subscriber>
  // What each subscriber asked to be told when this record stops being the
  // session (see endSubscriptions). Optional because a record that survived a
  // dev hot-reload predates it; such a record ends its subscribers silently.
  subscriberEnds?: Map<Subscriber, () => void>
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
  // Context compactions by compactionId, merged from the protocol's
  // ID-addressed patches (compaction_update replaces fields it carries;
  // compaction_summary_chunk appends). Optional — only agents whose harness
  // reports compaction ever populate it, and session records that survived a
  // dev hot-reload may predate the field (backfilled at the use site, same as
  // `commands`).
  compactions?: Map<string, CompactionState>
  // Subagents by subagentSessionId and background tasks by asyncTaskId,
  // merged from their upsert notifications. Optional for the same reason
  // `compactions` is: only reporting harnesses populate them, and hot-reload
  // survivors may predate the fields.
  subagents?: Map<string, SubagentInfo>
  asyncTasks?: Map<string, AsyncTaskInfo>
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
  /**
   * Notifications the host issued (see `notify`) that could not be handed over
   * yet: a turn was running that could not take them, or the host's delivery
   * gate was closed. Oldest first.
   *
   * Not the queue, and deliberately so. Everything in the queue is a message
   * to be read at the reader's pace — shown as unread, persisted, held by
   * Presence. A notification is none of those, and a queue entry that had to
   * opt out of every one of them would be a queue entry in name only, waiting
   * for the next queue feature to forget the exception.
   */
  notifications?: HeldNotification[]
  /**
   * The batch out for a steer right now, awaiting the harness's answer.
   *
   * On the session rather than in the steering call's own scope, so that the
   * two things that can overtake that answer can still reach the batch: the
   * turn settling first (startNotificationTurn takes it back and delivers it
   * as a turn of its own) and the session going away (releaseNotifications
   * owes every caller an answer, this batch's included).
   */
  notificationSteer?: HeldNotification[]
  // True only while session/load is replaying this session's history. The
  // replay carries no turn boundaries of its own, so handleUpdate reconstructs
  // them while this is set — see the `user_message_chunk` case.
  replaying?: boolean
  // Set by refreshMcpServers() when it finds this session mid-turn, instead of
  // resuming it immediately — a resume rides the same connection a live
  // prompt is streaming over. settleTurn applies the deferred resume once the
  // turn that was running actually finishes, and clears this.
  pendingMcpRefresh?: boolean
  // The agent's execution plan (ACP `plan` session update), mirrored here (like
  // usage/modes/queue) so a windowed subscribe/getEventsWindow can synthesize
  // it when the cut fell before every plan event — see the SNAPSHOT_KINDS
  // handling in fold.ts and withSnapshotPrefix. Every update replaces this
  // wholesale (the wire contract is a complete entry list, not a patch), and an
  // EMPTY list clears: claude-agent-acp publishes one when a conversation reset
  // retires the plan. Absent = no plan has ever arrived; [] = one was published
  // empty.
  plan?: PlanItem[]
  // Last usage_update seen, mirrored here (like modes/configOptions/queue) so
  // a windowed subscribe/getEventsWindow can synthesize it without scanning
  // history — see the SNAPSHOT_KINDS handling below. This is the DISPLAYED
  // value (see the monotonic-within-turn rule at the usage_update case below)
  // — it can lag the harness's true current reading while a turn is active.
  // `cost`/`rateLimits` are the session- and account-scale state that rode
  // alongside a reading; they persist across readings instead of being reset
  // by the next bare used/size one.
  usage?: SessionUsage
  // The latest RAW usage_update reading for the active turn, even one the
  // monotonic-within-turn rule held back from `usage` — settleTurn applies it
  // in full at the turn boundary. See the usage_update case for why.
  pendingUsage?: { used: number; size?: number }
  // Cumulative session cost already attributed to earlier turns, so the next
  // turn boundary can hand over just its own increment (see settleTurn). Starts
  // absent — the first priced turn's delta is the whole figure — and tracks the
  // running total as reported. A drop below it is a compaction/conversation
  // reset, after which the fresh cumulative IS the turn's cost.
  costAccountedFor?: number
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
  // Whether the agent advertised `sessionCapabilities.resume` at initialize —
  // reattaching to a persisted session WITHOUT a history replay. The
  // distinction from `loadSession` is the whole of restoreSession's reason to
  // exist: load hands the transcript back, resume only hands the agent back.
  // Only meaningful once `initialized` has resolved.
  resumeSession: boolean
  // Whether the harness advertised the steering extension at initialize
  // (`_meta.steering.supported`). This is the harness's OWN word about
  // mid-turn input — one of the two ways it gets enabled (see
  // supportsMidTurnInput; the other is the adapter's forced flag). Only
  // meaningful once `initialized` has resolved.
  steeringSupported: boolean
  // Whether the agent advertised the `session/fork` capability at initialize
  // (agentCapabilities.sessionCapabilities.fork; `{}` means supported, per the
  // same spelling as elicitation). Only meaningful once `initialized` has
  // resolved.
  forkSupported: boolean
  // Whether the agent advertised `agentCapabilities.promptCapabilities.image`
  // at initialize. A real boolean in the spec, not a marker object like the
  // session capabilities above. Without it the client MUST NOT put an image
  // block in a prompt, so this is what decides whether an attachment travels.
  // Only meaningful once `initialized` has resolved.
  imagePrompt: boolean
  // Resolves when initialize() has completed and the capability flags above
  // are set. Every caller (spawner and concurrent reusers) awaits this before
  // using the connection, so capability checks never race a half-open
  // connection.
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
  // subagentSessionId -> parent sessionId, for routing a subagent's own
  // session/update notifications into the parent's transcript. Entries live
  // as long as the parent session does (see deleteSession's cleanup) — a
  // terminal subagent may still have chunks in flight.
  subagentParents: Map<string, string>
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
    subagentParents: new Map(),
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
store.subagentParents ??= new Map()

function textOf(content: ContentBlock): string {
  if (content.type === 'text') {
    return content.text
  }
  return `[${content.type}]`
}

/**
 * The envelope a harness sends its own model to wake it when a background task
 * finishes. It travels as an ordinary user message, and it is not one.
 *
 * Addressed to the MODEL, in the model's own vocabulary: a task id, the tool
 * use that started it, the file its output went to, a status. The reader has
 * already been told the same thing in their own — the harness reports the
 * task's state as an entity alongside this, which is what the background-task
 * strip draws. Left in the transcript it renders as the reader having pasted a
 * block of XML into the conversation, mid-turn, saying something they did not
 * say.
 *
 * Matched on the opening tag rather than the whole shape: the envelope carries
 * different fields depending on what finished (an agent's result, a note about
 * repeat notifications), and a reader would be shown the raw thing either way.
 */
const TASK_NOTIFICATION_TAG = '<task-notification>'

function isTaskNotification(text: string): boolean {
  return text.trimStart().startsWith(TASK_NOTIFICATION_TAG)
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
  // Same shape as a settled tool call: a turn can genuinely end on the
  // compaction it ran (an explicit /compact turn does exactly that).
  if (tail.kind === 'compaction') {
    return isTerminalToolStatus(tail.compaction.status)
  }
  return false
}

// The host's optional observation hook (AgentClientOptions.onEvent), installed
// by createAgentClient. Module-level, like `store`, because emit() is
// module-level and fires for every session rather than per client instance.
let onEventHook: ((sessionId: string, event: ChatEvent, sessionKey?: string) => void) | undefined

// Same shape and reasoning for AgentClientOptions.onCompaction — handleUpdate,
// its caller, is module-level too.
let onCompactionHook: ((sessionId: string, compaction: CompactionState) => void) | undefined

// A record leaving the store ends every subscription on it.
//
// A subscriber holds the RECORD, not the id, and emit only reaches the record
// the store holds now. So a record that is dropped (an unload, a stop, a
// delete) or replaced under the same id (a session reopened by restore or
// load after one of those) left its subscribers attached to an object nothing
// would ever emit into again. That is a chat that looks live and never moves:
// a message sent from it reaches the agent through the reopened session, the
// agent works, and not one event of it reaches the reader.
function endSubscriptions(session: SessionState | undefined): void {
  if (!session) {
    return
  }
  const ends = [...(session.subscriberEnds?.values() ?? [])]
  session.subscribers.clear()
  session.subscriberEnds?.clear()
  for (const end of ends) {
    try {
      end()
    } catch {}
  }
}

// Every write of a session record goes through here, so a record already held
// under the id ends its subscriptions rather than being overwritten under them.
function putSession(sessionId: string, session: SessionState): void {
  const previous = store.sessions.get(sessionId)
  if (previous !== session) {
    endSubscriptions(previous)
  }
  store.sessions.set(sessionId, session)
}

function dropSession(sessionId: string): void {
  endSubscriptions(store.sessions.get(sessionId))
  store.sessions.delete(sessionId)
}

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
      onEventHook(sessionId, event, session.meta.sessionKey)
    } catch {}
  }
}

// A 'usage' ChatEvent spelled from a session-usage snapshot: the used/size
// pair plus whichever of cost/rateLimits it holds. One spelling for every
// site that publishes one (the snapshot prefix, a live reading, the turn
// settlement), so a new field rides all of them or none.
function usageEventOf(usage: SessionUsage): Extract<ChatEvent, { kind: 'usage' }> {
  return {
    kind: 'usage',
    used: usage.used,
    size: usage.size,
    ...(usage.cost ? { cost: usage.cost } : {}),
    ...(usage.rateLimits ? { rateLimits: usage.rateLimits } : {}),
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
    prefix.push(usageEventOf(session.usage))
  }
  // The live plan, for the same reason usage is here: present-tense state. A
  // window cut before every plan event would otherwise hide the one thing the
  // reader most needs on reopening a long session — what the agent is working
  // through now. Empty means the plan was cleared, never announced, so nothing
  // is synthesized for it (matching every line above: only non-defaults go).
  if (session.plan && session.plan.length > 0 && !has('plan')) {
    prefix.push({ kind: 'plan', entries: session.plan.map((entry) => ({ ...entry })) })
  }
  if (session.queue.length > 0 && !has('queue')) {
    prefix.push({ kind: 'queue', items: [...session.queue] })
  }
  // LIVE background tasks only. A finished task is transcript history — a
  // window that scrolled past it is no more entitled to it than to an old
  // tool call — but a task still running is present-tense state the reader
  // is otherwise blind to, which is the exact failure this feature removes.
  for (const task of session.asyncTasks?.values() ?? []) {
    if ((task.state === 'running' || task.state === 'paused') && !has('async_task')) {
      prefix.push({ kind: 'async_task', task: { ...task } })
    }
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

// Held notifications go out as ONE prompt, a blank line between them. Each is
// a self-contained block in the host's own wording, and the engine adds
// nothing of its own around them — no tag, no note, nothing a reader or a
// parser would have to tell apart from what the host wrote.
const NOTIFICATION_SEPARATOR = '\n\n'

function settleNotifications(batch: readonly HeldNotification[], handedOver: boolean): void {
  for (const notification of batch) {
    notification.settle(handedOver)
  }
}

/**
 * Answer every notification still held for a session that is going away: not
 * handed over.
 *
 * Called wherever a record leaves the session map. A held notification's
 * promise is settled by its delivery and by nothing else, so a record dropped
 * with one inside would leave its caller waiting on a session that no longer
 * exists — and a host delivering at-least-once keeps its work marked
 * undelivered until it hears back. False is that host's cue to try again
 * against whatever session the conversation has next.
 */
function releaseNotifications(session: SessionState | undefined): void {
  if (!session) {
    return
  }
  const held = [...(session.notificationSteer ?? []), ...(session.notifications ?? [])]
  session.notificationSteer = undefined
  session.notifications = []
  settleNotifications(held, false)
}

// The harness's own message boundary, when the chunk carries one — spread
// into the event so an absent id stays an absent FIELD rather than an
// explicit undefined (events are compared whole in tests and snapshots).
function chunkMessageId(update: { messageId?: string | null }): { messageId?: string } {
  return update.messageId ? { messageId: update.messageId } : {}
}

// The tool's own name off a tool-call update, spread in for the same reason as
// the message id above.
//
// Two places carry it and neither is guaranteed: ACP's own `name` field on the
// notification, and the Claude bridge's `_meta.claudeCode.toolName`, which is
// the one still present on an update that only refines a call already
// announced. Preferring the protocol field and falling back to the extension
// keeps this correct for any agent while still answering for the bridge we
// actually run.
function toolName(update: Record<string, unknown>): { name?: string } {
  const own = update.name
  if (typeof own === 'string' && own) {
    return { name: own }
  }
  const meta = (update._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName
  return typeof meta === 'string' && meta ? { name: meta } : {}
}

// A subagent session's own update, translated to the event vocabulary for
// nesting into the parent transcript. Only the conversation subset — the
// session-state kinds (modes, config, usage, …) describe the CHILD session,
// which holds no state of its own here, and folding them into the parent
// would overwrite the parent's.
function childEventOf(update: SessionNotification['update']): ChatEvent | null {
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      // Same rule as the parent's own user chunks (see isTaskNotification): a
      // subagent that spawns background work is woken the same way, and the
      // envelope is no more the reader's business nested than it is at the top
      // level.
      const text = textOf(update.content)
      return isTaskNotification(text) ? null : { kind: 'user', text, ...chunkMessageId(update) }
    }
    case 'agent_message_chunk':
      return { kind: 'agent_message', text: textOf(update.content), ...chunkMessageId(update) }
    case 'agent_thought_chunk':
      return { kind: 'agent_thought', text: textOf(update.content), ...chunkMessageId(update) }
    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status ?? 'pending',
        toolKind: update.kind,
        input: update.rawInput,
        ...toolName(update as unknown as Record<string, unknown>),
      }
    case 'tool_call_update':
      return {
        kind: 'tool_update',
        toolCallId: update.toolCallId,
        title: update.title ?? undefined,
        status: update.status ?? undefined,
        input: update.rawInput ?? undefined,
        output: toolOutputText(update.content, update.rawOutput),
      }
    default:
      return null
  }
}

// Reads one string/boolean field off an untyped draft update without
// inventing values: absent or mistyped answers undefined.
function draftString(update: Record<string, unknown>, key: string): string | undefined {
  const value = update[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The draft update kinds the SDK union doesn't carry yet. True means the
 * update was one of them (handled or not — an unknown session still consumes
 * it); false sends the caller on to the typed switch.
 *
 * Subagent and async-task entities follow the compaction pattern: the session
 * holds the merged record, every emit carries its full current state, and
 * consumers fold by replacement keyed on the entity id.
 */
function handleExtensionUpdate(
  sessionId: string,
  update: Record<string, unknown> & { sessionUpdate: string },
): boolean {
  switch (update.sessionUpdate) {
    case 'subagent_spawned': {
      const session = store.sessions.get(sessionId)
      const subagentSessionId = draftString(update, 'subagentSessionId')
      if (!session || !subagentSessionId) {
        return true
      }
      const info: SubagentInfo = {
        subagentSessionId,
        name: draftString(update, 'name') ?? '',
        task: draftString(update, 'task') ?? '',
      }
      session.subagents ??= new Map()
      session.subagents.set(subagentSessionId, info)
      store.subagentParents.set(subagentSessionId, sessionId)
      emit(sessionId, { kind: 'subagent', subagent: { ...info } })
      return true
    }
    case 'subagent_state_update': {
      const session = store.sessions.get(sessionId)
      const subagentSessionId = draftString(update, 'subagentSessionId')
      if (!session || !subagentSessionId) {
        return true
      }
      session.subagents ??= new Map()
      // A terminal-first arrival (announce lost to a replay gap) still gets a
      // record — nameless, but placed and closed rather than dropped.
      const info = session.subagents.get(subagentSessionId) ?? { subagentSessionId, name: '', task: '' }
      info.state = draftString(update, 'state') ?? info.state
      session.subagents.set(subagentSessionId, info)
      emit(sessionId, { kind: 'subagent', subagent: { ...info } })
      return true
    }
    case 'async_task_spawned':
    case 'async_task_progress':
    case 'async_task_state_update': {
      const session = store.sessions.get(sessionId)
      const asyncTaskId = draftString(update, 'asyncTaskId')
      if (!session || !asyncTaskId) {
        return true
      }
      session.asyncTasks ??= new Map()
      const previous = session.asyncTasks.get(asyncTaskId)
      const task: AsyncTaskInfo = previous
        ? { ...previous }
        : {
            asyncTaskId,
            name: draftString(update, 'name') ?? '',
            taskType: draftString(update, 'taskType') ?? '',
            description: draftString(update, 'description') ?? '',
            state: 'running',
            canStop: update.canStop === true,
            showInTranscript: update.showInTranscript !== false,
          }
      if (update.sessionUpdate === 'async_task_spawned') {
        task.name = draftString(update, 'name') ?? task.name
        task.taskType = draftString(update, 'taskType') ?? task.taskType
        task.canStop = update.canStop === true
        task.showInTranscript = update.showInTranscript !== false
      }
      const description = draftString(update, 'description')
      if (description !== undefined) {
        task.description = description
      }
      const summary = draftString(update, 'summary')
      if (summary !== undefined) {
        task.summary = summary
      }
      const lastToolName = draftString(update, 'lastToolName')
      if (lastToolName !== undefined) {
        task.lastToolName = lastToolName
      }
      const outputFilePath = draftString(update, 'outputFilePath')
      if (outputFilePath !== undefined) {
        task.outputFilePath = outputFilePath
      }
      const toolCallId = draftString(update, 'toolCallId')
      if (toolCallId !== undefined) {
        task.toolCallId = toolCallId
      }
      const usage = update.usage
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const { totalTokens, toolUses, durationMs } = usage as Record<string, unknown>
        if (typeof totalTokens === 'number' && typeof toolUses === 'number' && typeof durationMs === 'number') {
          task.usage = { totalTokens, toolUses, durationMs }
        }
      }
      if (update.sessionUpdate === 'async_task_state_update') {
        task.state = draftString(update, 'state') ?? task.state
      }
      session.asyncTasks.set(asyncTaskId, task)
      emit(sessionId, { kind: 'async_task', task: { ...task } })
      return true
    }
    default:
      return false
  }
}

// The draft session-update kinds this client understands AHEAD of its own ACP
// SDK: subagents (ACP draft #1992) and JetBrains AIR async tasks. Deliberately
// the same set handleExtensionUpdate recognizes — the stream filter below
// decides transport, that function decides meaning.
const DRAFT_SESSION_UPDATE_KINDS = new Set([
  'subagent_spawned',
  'subagent_state_update',
  'async_task_spawned',
  'async_task_progress',
  'async_task_state_update',
])

function isDraftSessionUpdate(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) {
    return false
  }
  const frame = message as { method?: unknown; id?: unknown; params?: { update?: { sessionUpdate?: unknown } } }
  return (
    frame.method === 'session/update' &&
    frame.id === undefined &&
    typeof frame.params?.update?.sessionUpdate === 'string' &&
    DRAFT_SESSION_UPDATE_KINDS.has(frame.params.update.sessionUpdate)
  )
}

/**
 * Wrap a connection stream so draft-kind session updates never reach the ACP
 * SDK. The SDK validates every inbound session/update against the schema
 * union of the kinds it shipped with (verified on 1.4.0: zSessionUpdate
 * carries neither the ACP #1992 subagent kinds nor AIR's async-task kinds), and
 * an unknown kind fails the parse — silently dropping the notification the
 * harness only sent because we advertised the capability for it. Unit tests
 * feeding handleUpdate directly never crossed this seam, which is how the
 * gap shipped: the harness announced subagents and this client never heard.
 *
 * Draft updates are handed straight to handleUpdate and withheld from the
 * SDK; they are notifications (no id), so swallowing them is protocol-safe.
 * A JSON-RPC batch is split for correctness, not traffic — nothing batches
 * today, but a filter that only looks at top-level frames would silently
 * regress the day something does.
 */
export function interceptDraftSessionUpdates(stream: Stream): Stream {
  const consume = (frame: unknown) => {
    try {
      handleUpdate((frame as { params: SessionNotification }).params)
    } catch (error) {
      console.error('[agent-client] draft session update failed', error)
    }
  }
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          if (isDraftSessionUpdate(message)) {
            consume(message)
            return
          }
          if (Array.isArray(message) && message.some(isDraftSessionUpdate)) {
            const rest = message.filter((entry) => {
              if (isDraftSessionUpdate(entry)) {
                consume(entry)
                return false
              }
              return true
            })
            if (rest.length > 0) {
              // A batch is an AnyWireMessage; the Stream's default element
              // type does not name it, but ndJsonStream forwards batches
              // verbatim, so what goes back out is exactly what came in.
              controller.enqueue(rest as unknown as typeof message)
            }
            return
          }
          controller.enqueue(message)
        },
      }),
    ),
  }
}

// Dispatches an inbound session/update notification to store state + a
// ChatEvent. Exported so tests can drive it directly — the real caller is the
// ACP Client wired up per spawned connection (buildClient below), which test
// mocks bypass entirely by seeding store.connections with a fake AgentConnection.
export function handleUpdate(notification: SessionNotification): void {
  const { sessionId, update } = notification
  // Draft update kinds (subagents, async tasks — ACP #1992 / AIR) aren't in
  // the SDK's typed union yet; recognized by name ahead of the switch below.
  if (handleExtensionUpdate(sessionId, update as unknown as Record<string, unknown> & { sessionUpdate: string })) {
    return
  }
  // A notification addressed to a subagent's own session id is one step of
  // that subagent's transcript, nested into the parent's log — the parent is
  // the session a subscriber is actually watching.
  const parentId = store.subagentParents.get(sessionId)
  if (parentId !== undefined && !store.sessions.has(sessionId)) {
    const childEvent = childEventOf(update)
    if (childEvent) {
      emit(parentId, { kind: 'subagent_event', subagentSessionId: sessionId, event: childEvent })
    }
    return
  }
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
      const text = textOf(update.content)
      // Before the boundary, not after it: a notification that is not part of
      // the conversation must not end a turn either, or a reader would be shown
      // their own turn split in two at a message nobody sent.
      if (isTaskNotification(text)) {
        break
      }
      const session = store.sessions.get(sessionId)
      const previous = session?.replaying ? lastConversationEvent(session.events) : undefined
      if (previous && previous.kind !== 'user') {
        emit(sessionId, { kind: 'turn_end', stopReason: 'replayed' })
      }
      emit(sessionId, { kind: 'user', text, ...chunkMessageId(update) })
      break
    }
    case 'agent_message_chunk': {
      emit(sessionId, { kind: 'agent_message', text: textOf(update.content), ...chunkMessageId(update) })
      break
    }
    case 'agent_thought_chunk': {
      emit(sessionId, { kind: 'agent_thought', text: textOf(update.content), ...chunkMessageId(update) })
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
        ...toolName(update as unknown as Record<string, unknown>),
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
      const entries: PlanItem[] = update.entries.map((entry) => ({
        content: entry.content,
        status: entry.status,
        priority: entry.priority,
      }))
      // Mirrored onto the session (like usage) so a windowed subscriber whose
      // cut fell before every plan event is still handed the current plan —
      // withSnapshotPrefix below. An empty list is stored as-is: it is the
      // wire's way of retiring a plan, and prefixing it would resurrect one
      // the agent cleared.
      const session = store.sessions.get(sessionId)
      if (session) {
        session.plan = entries
      }
      emit(sessionId, { kind: 'plan', entries })
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
      //
      // What else rides the update is session- and account-scale, not a
      // per-turn reading, so it is merged rather than held: the session's
      // cumulative cost (`cost`, when the harness prices the session) and the
      // subscription rate-limit windows (the claude bridge's
      // `_claude/rateLimit` `_meta`, one window per event, merged by window
      // name). A later reading that carries neither leaves both alone — a
      // turn-end result reports cost but no limit state, a rate-limit event
      // reports limits but no cost, and neither is a retraction of the other.
      const cost =
        update.cost && Number.isFinite(update.cost.amount)
          ? { amount: update.cost.amount, currency: update.cost.currency }
          : session.usage?.cost
      const rateLimit = parseRateLimit(update._meta)
      const rateLimits = rateLimit ? mergeRateLimit(session.usage?.rateLimits, rateLimit) : session.usage?.rateLimits
      // The raw reading is kept even when held, so settleTurn can apply it in
      // full at the turn boundary (the monotonic rule's promised decrease).
      session.pendingUsage = { used: update.used, size }
      // THE HELD READING ITSELF, not a flag saying there is one. A boolean
      // cannot tell the compiler that `session.usage` was present when it was
      // computed, so the merge below read as possibly-undefined and the
      // package's typecheck failed on both lines of it. Naming the value keeps
      // the narrowing where it is used, and says what is being held.
      const previous = session.usage
      const held =
        session.activeTurns > 0 && previous && size === previous.size && update.used < previous.used
          ? previous
          : undefined
      // A held reading keeps the displayed used/size (the monotonic rule) but
      // still merges the side state a bare reading carried — a cost or a
      // limit update is not a context reading and is never held.
      session.usage = {
        used: held ? held.used : update.used,
        size: held ? held.size : size,
        ...(cost ? { cost } : {}),
        ...(rateLimits ? { rateLimits } : {}),
      }
      if (held) {
        break
      }
      emit(sessionId, usageEventOf(session.usage))
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
    case 'compaction_update': {
      // An ID-addressed upsert (experimental ACP contract, opted into via
      // clientCapabilities.session.compaction): the first update for an ID
      // places the entity, later ones patch it — omitted fields stay, null
      // clears, a value replaces (`summary: []` also clears). The merged
      // record is what emits, so consumers fold by replacement and never
      // re-implement the patch rules.
      const session = store.sessions.get(sessionId)
      if (!session) {
        break
      }
      session.compactions ??= new Map()
      const previous = session.compactions.get(update.compactionId)
      const record: CompactionState = {
        ...(previous ?? { compactionId: update.compactionId }),
        status: update.status,
      }
      if (update.summary !== undefined) {
        const text = (update.summary ?? []).map(textOf).join('')
        record.summary = text || undefined
      }
      if (update.error !== undefined) {
        record.error = update.error ?? undefined
      }
      applyCompactionMeta(record, update._meta)
      session.compactions.set(update.compactionId, record)
      emit(sessionId, { kind: 'compaction', compaction: { ...record } })
      // Live status transitions only: the terminal update can arrive twice
      // (the bridge re-sends `completed` to enrich it with token counts once
      // the boundary reports them), and a session/load replay re-delivers the
      // whole lifecycle of every past compaction.
      if (!session.replaying && previous?.status !== record.status && onCompactionHook) {
        try {
          onCompactionHook(sessionId, { ...record })
        } catch {}
      }
      break
    }
    case 'compaction_summary_chunk': {
      // Streamed summary for an in-progress compaction. Accumulated silently:
      // the terminal update either replaces the summary wholesale (its
      // `summary` field wins, by the patch rules above) or omits it and lets
      // this accumulation stand. Not emitted per chunk — each event would have
      // to carry the full merged record, growing the log quadratically in the
      // summary's length for a live view the terminal update repaints anyway.
      const session = store.sessions.get(sessionId)
      if (!session) {
        break
      }
      session.compactions ??= new Map()
      const record = session.compactions.get(update.compactionId) ?? {
        compactionId: update.compactionId,
        status: 'in_progress',
      }
      record.summary = (record.summary ?? '') + textOf(update.content)
      session.compactions.set(update.compactionId, record)
      break
    }
    default:
      break
  }
}

// The bridge's provider-neutral compaction facts ride the update's `_meta`
// under this key (see @agentclientprotocol/claude-agent-acp's
// context-compaction-meta): trigger, token counts, duration. `_meta` is a
// replace-patch — the bridge only re-sends it when it adds facts — so fields
// merge into the record rather than resetting it.
const CONTEXT_COMPACTION_META_KEY = 'contextCompaction'

function applyCompactionMeta(record: CompactionState, meta: unknown): void {
  if (!meta || typeof meta !== 'object') {
    return
  }
  const facts = (meta as Record<string, unknown>)[CONTEXT_COMPACTION_META_KEY]
  if (!facts || typeof facts !== 'object') {
    return
  }
  const { trigger, preTokens, postTokens, durationMs } = facts as Record<string, unknown>
  if (trigger === 'manual' || trigger === 'automatic') {
    record.trigger = trigger
  }
  if (typeof preTokens === 'number') {
    record.preTokens = preTokens
  }
  if (typeof postTokens === 'number') {
    record.postTokens = postTokens
  }
  if (typeof durationMs === 'number') {
    record.durationMs = durationMs
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
      // A subagent asks under its OWN session id (ACP #1992), which no
      // subscriber watches — the prompt belongs in the parent's chat, the
      // session whose turn the subagent is part of, exactly as its transcript
      // steps are nested there (see handleUpdate). Emitting to the child id
      // would drop the event on the floor and leave the harness waiting on an
      // answer nobody can give.
      const sessionId = store.subagentParents.get(request.sessionId) ?? request.sessionId
      const perms = store.sessions.get(sessionId)?.permissions
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
          sessionId,
          resolve,
        })
        emit(sessionId, {
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
        // A session-scoped elicitation NAMES its session, and that is the one
        // it goes to — through the subagent routes, as a permission request
        // does. One harness process serves every session of its agent, so the
        // connection's "last prompted" session is only a guess, and it guessed
        // wrong whenever another of the agent's chats had been written to since:
        // the question was drawn, and recorded, in a chat whose agent was not
        // asking, while the one that was sat waiting on nothing visible.
        //
        // The guess is left for what has no session to name — a request-scoped
        // elicitation, raised while a session is being set up.
        const scoped = 'sessionId' in request && typeof request.sessionId === 'string' ? request.sessionId : undefined
        const sessionId = scoped ? (store.subagentParents.get(scoped) ?? scoped) : getElicitationSession()
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
        const form =
          request.mode === 'form' ? (request as { requestedSchema: ElicitationSchema }).requestedSchema : undefined
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

// Flatten a select config option's choice list; the options may be flat or
// grouped, like matchReasoningValue's.
function selectOptionValues(options: unknown): Array<{ name?: string; value?: string }> {
  if (!Array.isArray(options)) {
    return []
  }
  const flat: Array<{ name?: string; value?: string }> = []
  for (const entry of options as Array<Record<string, unknown>>) {
    if (Array.isArray(entry.options)) {
      flat.push(...(entry.options as Array<{ name?: string; value?: string }>))
    } else if (typeof entry.value === 'string') {
      flat.push(entry as { name?: string; value?: string })
    }
  }
  return flat
}

// Map a selection's model id to the value id of an ACP agent's model select
// option, for adapters that carry no modelEnv (OpenCode, Codex) — there the
// config option is the only channel a model choice can travel at all.
// Conservative on purpose: the exact option value, or the UNIQUE value whose
// `provider/` suffix equals the id (OpenCode spells models `provider/model`
// while a profile stores the bare id). Anything looser risks pinning a
// different model than the profile named, which is worse than leaving the
// harness default.
function matchModelValue(options: unknown, model: string): string | undefined {
  const flat = selectOptionValues(options)
  const target = model.trim().toLowerCase()
  if (!target) {
    return undefined
  }
  const exact = flat.find((option) => option.value?.toLowerCase() === target)
  if (exact?.value) {
    return exact.value
  }
  const bySuffix = flat.filter((option) => option.value?.toLowerCase().endsWith(`/${target}`))
  return bySuffix.length === 1 ? bySuffix[0].value : undefined
}

// Which config option carries which meaning. ACP marks it with `category`, and
// every bridge measured on this instance sends one, but the spec is explicit
// that the field is "UX only", MUST NOT be required for correctness, and that
// clients MUST handle a missing or unknown one gracefully. So the conventional
// id -- the same id the chat's own controls key on -- is the fallback. Category
// is tried first because it is the protocol's own statement of meaning, where
// an id is a name two unrelated options could both pick.
interface ConfigSelector {
  category: string
  id: string
}

const MODEL_SELECTOR: ConfigSelector = { category: 'model', id: 'model' }
const THOUGHT_LEVEL_SELECTOR: ConfigSelector = { category: 'thought_level', id: 'effort' }

function findSelectOption(options: readonly SessionConfigOption[], selector: ConfigSelector) {
  const hit =
    options.find((entry) => entry.type === 'select' && entry.category === selector.category) ??
    options.find((entry) => entry.type === 'select' && entry.id === selector.id)
  return hit?.type === 'select' ? hit : undefined
}

// The model that did most of the turn's work, off the harness's per-model
// quota breakdown: the entry with the largest total token count. The breakdown
// counts subagents and internal calls too, so the main loop's own model is the
// heaviest row in the ordinary case; picking by weight rather than position is
// what keeps a subagent-only model from being read as the turn's model. Absent
// when the harness sent no breakdown.
function largestQuotaModel(quota: TurnQuota | undefined): string | undefined {
  if (!quota?.modelUsage?.length) {
    return undefined
  }
  let best = quota.modelUsage[0]
  for (const row of quota.modelUsage) {
    if (row.tokenCount.totalTokens > best.tokenCount.totalTokens) {
      best = row
    }
  }
  return best.model
}

// "1 attachment" / "2 attachments" — the count is the point of these messages,
// so it is never dropped in favour of a bare plural.
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
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

// The turn cutoff of an ACP fork, translated into what the agent can act on.
//
// The ACP `session/fork` request carries no cutoff field of its own; the
// dialect is claude-agent-acp's (verified against its fork-session
// implementation, 0.78.0): `_meta.jetbrains.air.fork` names a
// fork point by the message id the agent itself stamps on its message chunks —
// the same id the engine keeps on `agent_message` events — and keeps its
// transcript up to and including that message. So the anchor for "drop from
// user turn N" is the LAST agent message strictly before that turn: the
// model-history twin of the event-log trim forkSession applies to its own copy.
//
// With no anchor — the boundary is the first turn, or every earlier turn
// produced no visible agent message — nothing expressible remains: the method
// has no "fork empty" spelling, so no fork point is sent and the agent copies
// the whole transcript. This session's log still rewinds (the reader sees the
// edit land), but the agent's own copy of the older turns stays in its context.
function forkCutoffMeta(session: { events: ChatEvent[] }, boundary: number | null): Record<string, unknown> | undefined {
  if (boundary === null) {
    return undefined
  }
  for (let i = boundary - 1; i >= 0; i -= 1) {
    const event = session.events[i]
    if (event.kind === 'agent_message' && event.messageId) {
      return { jetbrains: { air: { fork: { version: 1, messageId: event.messageId } } } }
    }
  }
  return undefined
}

// Whether a prompt to this agent may carry an image block, which is ACP's
// `agentCapabilities.promptCapabilities.image` and nothing looser: the spec
// says a client MUST NOT send the block to an agent that did not advertise it.
//
// The native harness answers from its own declaration, read straight off the
// module: it is never handshaken — a native selection is not spawned, so there
// is no connection entry to read an initialize answer from.
//
// A session whose connection is not up yet answers false, which is the
// conservative side: a host reading this to place an attach control shows it
// disabled with a reason until the harness has spoken, rather than offering
// something that would be refused.
//
// Exported so a host's composer offers attaching exactly where the engine would
// actually send it. The engine reads this same function when it builds a
// prompt's blocks, so the control and the delivery cannot disagree.
export function supportsImagePrompt(selection: AgentSelection): boolean {
  if (isNativeSelection(selection)) {
    return NATIVE_PROMPT_CAPABILITIES.image
  }
  return store.connections.get(spawnKey(buildSpawnConfig(selection)))?.imagePrompt === true
}

// Whether this agent accepts a prompt while a turn is running, feeding it into
// the live turn ("steering"). True on either of two words, and only those:
//
//  - the HARNESS's own: it advertised the steering extension at initialize
//    (`_meta.steering.supported`, captured per connection) — the honest
//    signal, since ACP proper has no capability for this; or
//  - OURS, forced: the adapter's `supportsMidTurnInput` flag, for a harness
//    verified to steer without advertising it.
//
// A session whose connection is not up yet answers from the forced flag alone
// — the conservative side: its messages queue, the next turn delivers them,
// and once the connection reports in, mid-turn sends start steering. Off, the
// engine queues mid-turn prompts and delivers them as turns end. Exported so
// hosts adapt their turn-control UX to the same resolution the engine acts on.
//
// CAPABILITY only. Whether a given message actually steers is also the
// reader's cadence's call — see steersMidTurn.
export function supportsMidTurnInput(selection: AgentSelection): boolean {
  if (findAdapter(selection.adapterId)?.supportsMidTurnInput === true) {
    return true
  }
  if (isNativeSelection(selection)) {
    return false
  }
  return store.connections.get(spawnKey(buildSpawnConfig(selection)))?.steeringSupported === true
}

// Whether THIS session's messages go into a running turn: the harness must be
// able to (supportsMidTurnInput) AND the reader must be reading `realtime` —
// the one cadence that means "as it arrives, even mid-turn". Every other
// cadence is a promise that messages wait: for the window, or (online and
// high-attention, each in its own way) for a turn boundary — high-attention
// forces one, online waits for the agent's own.
/**
 * Live background work: a subagent the harness has not given a terminal state
 * for, or a task still running or paused — the harness's own, or one the host
 * runs for the session (upsertAsyncTask), which is the same record.
 *
 * Module-level so the steering rule below and the public `hasBackgroundWork`
 * read the same predicate — they answer the same question for two callers, and
 * two copies of "is anything still running" would drift on the first new kind
 * of background work.
 */
function hasLiveBackgroundWork(session: SessionState): boolean {
  for (const subagent of session.subagents?.values() ?? []) {
    if (subagent.state === undefined) {
      return true
    }
  }
  for (const task of session.asyncTasks?.values() ?? []) {
    if (task.state === 'running' || task.state === 'paused') {
      return true
    }
  }
  return false
}

/**
 * Whether a waiting message goes INTO the turn that is running, rather than
 * waiting for its end.
 *
 * `realtime` is the cadence that asks for that, and a harness that advertised
 * the steering extension is one that can take it. Those two, and only those.
 *
 * DELIVERED EVEN MID-DELEGATION. Steering is an injection, never a cancel: the
 * bridge pushes the message onto the running turn's input and re-applies the
 * turn's subagent hold across it (claude-agent-acp `steer()`), so a realtime
 * reader reaches the agent while its subagents are still running — which is the
 * whole point of realtime, and was the exact thing a reader could not do while
 * this was gated on `!hasLiveBackgroundWork`. What DOES finish a turn's
 * subagents as `cancelled` is `session/cancel` (verified in the bridge's cancel
 * handler), so the delivery mechanism, not the cadence, is what must avoid it —
 * see deliverPrompt and the `push` paths, which steer rather than cancel
 * wherever the harness supports it.
 */
function steersMidTurn(session: SessionState): boolean {
  return session.presence.kind === 'realtime' && supportsMidTurnInput(session.selection)
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
  onCompactionHook = options.onCompaction
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

  // Fork an external ACP session over `session/fork` (the entry's agent
  // advertised the capability — forkSession checked). Mirrors loadSession's
  // session setup: a fork is a NEW session to the agent, so it gets this
  // session's MCP servers with a fresh permission token, bound to the id the
  // agent mints for the fork. `boundary` is the event-log index the cutoff
  // names (null = no cutoff); see forkCutoffMeta for how it travels.
  async function forkExternalSession(
    session: SessionState,
    entry: ConnEntry | undefined,
    boundary: number | null,
  ): Promise<Awaited<ReturnType<AgentConnection['unstable_forkSession']>>> {
    const selection = session.selection
    if (entry?.forkSupported !== true) {
      throw new Error('Forking is only supported by the in-process native harness.')
    }
    let token: string | null = null
    let mcpServers: AcpMcpServer[] = []
    if (supportsTools(selection)) {
      const { internal, servers } = await buildMcpServers(selection)
      token = randomUUID()
      store.acpTokenPermissions.set(token, session.permissions)
      mcpServers = tagInternal(internal, servers, token)
    }
    try {
      const response = await entry.connection.unstable_forkSession({
        sessionId: session.meta.id,
        cwd: selection.cwd,
        mcpServers,
        _meta: forkCutoffMeta(session, boundary),
      })
      if (token) {
        store.acpTokenSession.set(token, response.sessionId)
      }
      return response
    } catch (error) {
      // The fork never happened: unwind the token so a permission record can't
      // outlive the session it was minted for.
      if (token) {
        store.acpTokenPermissions.delete(token)
      }
      throw error
    }
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
    const stream = interceptDraftSessionUpdates(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )
    // The client factory closes over `entry.lastSessionId` to scope elicitations
    // to this connection. The factory only runs lazily (on the first message),
    // by which point `entry` is assigned — so the forward reference is safe.
    let entry: ConnEntry
    const connection = new ClientSideConnection(
      () => buildClient(() => entry.lastSessionId, mcpServerName, options.permissionHandler),
      stream,
    )
    entry = {
      process: child,
      connection,
      lastSessionId: null,
      loadSession: false,
      resumeSession: false,
      steeringSupported: false,
      forkSupported: false,
      imagePrompt: false,
      initialized: Promise.resolve(),
    }
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
            // The compaction opt-in (experimental): with it, an agent reports
            // context compactions as first-class compaction_update /
            // compaction_summary_chunk session updates — handled above in
            // handleUpdate — instead of claude-agent-acp's legacy synthetic
            // "Compact conversation" tool call. Same `{}`-means-supported
            // spelling as elicitation.
            session: { compaction: {} },
            // Two draft opt-ins the SDK's ClientCapabilities type doesn't
            // carry yet (spread past its excess-property check on purpose):
            //
            // `subagents` (ACP draft #1992): with it, the harness announces
            // each spawned subagent (`subagent_spawned` / `subagent_state_update`)
            // and routes the subagent's own activity as session/update
            // notifications under its OWN subagentSessionId, instead of
            // flattening everything into the parent transcript.
            //
            // The top-level spelling does NOT actually land today: the agent
            // side parses initialize with ITS bundled SDK's schema, whose
            // zClientCapabilities is a stripping z.object with no `subagents`
            // key (verified on claude-agent-acp 0.78.0 / sdk 1.4.0 — this is
            // exactly why a live subagent turn came back flattened while the
            // unit path worked). Kept anyway for the SDK release that adds
            // the key; `nativeSubagentSessions` in the AIR capability list
            // below is the spelling that survives, because `_meta` is a
            // passthrough record.
            //
            // The JetBrains AIR `_meta` capabilities claude-agent-acp checks:
            // `asyncTasks` — background work (detached bash jobs, loops)
            // reports as async_task_spawned / async_task_progress /
            // async_task_state_update instead of being invisible between
            // turns; `nativeSubagentSessions` — the AIR alias for the
            // subagents opt-in above; `sessionFailure` — typed turn failures
            // (a quota exhaustion, an auth requirement) instead of a generic
            // error rejection: the harness attaches its structured verdict to
            // the prompt response's `_meta`, which the turn settlement parses
            // (see usage-meta). Without the declaration the bridge falls back
            // to a bare rejection and the reason degrades to an error string.
            ...({ subagents: {} } as Record<string, unknown>),
            _meta: {
              jetbrains: {
                air: { version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions', 'sessionFailure'] },
              },
            },
          },
          clientInfo,
        })
        entry.loadSession = Boolean(
          (initResult as { agentCapabilities?: { loadSession?: boolean } }).agentCapabilities?.loadSession,
        )
        // Presence of the key is the capability; ACP's session capabilities are
        // empty marker objects, so `resume: {}` means supported and reading it
        // as a boolean would make every one of them false.
        entry.resumeSession =
          (initResult as { agentCapabilities?: { sessionCapabilities?: { resume?: unknown } } }).agentCapabilities
            ?.sessionCapabilities?.resume !== undefined
        // The steering extension has no ACP capability field; the harness
        // advertises it via initialize's top-level response `_meta` (see
        // claude-agent-acp's `_session/steering` contract).
        entry.steeringSupported = Boolean(
          (initResult as { _meta?: { steering?: { supported?: boolean } } })._meta?.steering?.supported,
        )
        // The SDK's session/fork extension. The agent's own word about whether
        // `unstable_forkSession` will be answered — the same read-back pattern
        // as loadSession above, and the same `{}`-means-supported spelling.
        entry.forkSupported = Boolean(
          (initResult as { agentCapabilities?: { sessionCapabilities?: { fork?: unknown } } }).agentCapabilities
            ?.sessionCapabilities?.fork,
        )
        // Prompt capabilities, unlike the session ones, are declared as real
        // booleans — so this one is read as a boolean and not for presence.
        // Measured 2026-09-22: claude-agent-acp 0.79.0 and opencode 1.18.32
        // both answer `image: true` (and `embeddedContext: true`); neither
        // claims `audio`.
        entry.imagePrompt = Boolean(
          (initResult as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } }).agentCapabilities
            ?.promptCapabilities?.image,
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
  /**
   * Inject a message into the session's RUNNING turn via the harness's
   * `_session/steering` extension. True means delivered: the injection was
   * accepted and the running turn owns the response. False means "use the
   * normal prompt path" for any reason at all — the harness never advertised
   * the extension (a forced-only adapter), the connection exposes no
   * extension channel (native harness, a seeded test double), the turn ended
   * in the race window (`idleBehavior: promptRequired` answers without
   * injecting), or the request itself failed. Callers treat every false
   * identically, so a steering failure degrades to exactly the delivery that
   * existed before steering did.
   *
   * The user event emits only AFTER an accepted injection, not before the
   * request: a false return falls through to deliverPrompt's own emit, and
   * emitting on both sides would show the message twice. The response frame
   * arrives before the model can have replied to the injection, so the
   * transcript still orders the message ahead of everything it caused.
   */
  async function steerIntoRunningTurn(
    sessionId: string,
    session: SessionState,
    deliveredText: string,
    prompt: ContentBlock[],
    attachments: DeliveredAttachment[],
    problems: string[],
  ): Promise<boolean> {
    if (!supportsMidTurnInput(session.selection)) {
      return false
    }
    const entry = connEntryFor(session.selection)
    if (!entry?.steeringSupported || typeof entry.connection.extMethod !== 'function') {
      return false
    }
    try {
      const result = await entry.connection.extMethod('_session/steering', {
        sessionId,
        prompt,
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      })
      if ((result as { outcome?: string }).outcome !== 'injected') {
        return false
      }
    } catch (error) {
      // Surfaced rather than swallowed — the fallback prompt below still
      // delivers the message, but a steering channel that errors is worth a
      // line in the transcript while the contract is this young.
      emit(sessionId, {
        kind: 'error',
        message: `steering failed, delivered as a prompt instead: ${errorMessage(error)}`,
      })
      return false
    }
    store.lastSessionId = sessionId
    entry.lastSessionId = sessionId
    emitDelivery(sessionId, deliveredText, attachments, problems)
    return true
  }

  /**
   * The transcript's record of a delivery: its text, what it carried, and then
   * whatever of that did not make it.
   */
  function emitDelivery(
    sessionId: string,
    text: string,
    attachments: DeliveredAttachment[],
    problems: readonly string[],
  ): void {
    emit(sessionId, attachments.length > 0 ? { kind: 'user', text, attachments } : { kind: 'user', text })
    for (const message of problems) {
      emit(sessionId, { kind: 'error', message })
    }
  }

  /**
   * The blocks one delivery hands over: the message, and an image block for
   * every attachment it carries.
   *
   * Text first. ACP puts no ordering rule on the array, and the words before
   * the picture is the order the reader wrote them in.
   *
   * Every way this can fall short says so in the transcript. An attachment that
   * quietly did not travel is the whole failure mode worth engineering against
   * here: the reader sees their picture in their own message, the agent answers
   * as though there were none, and nothing connects the two. Nothing here is a
   * guess about whether something WAS an attachment -- they arrive as a field,
   * never read out of the words -- so every one of these reports is true.
   */
  async function promptBlocks(
    session: SessionState,
    text: string,
    attachments: readonly AttachmentRef[],
  ): Promise<{ blocks: ContentBlock[]; problems: string[] }> {
    const blocks: ContentBlock[] = [{ type: 'text', text }]
    if (attachments.length === 0) {
      return { blocks, problems: [] }
    }
    const harness = findAdapter(session.selection.adapterId)?.label ?? 'This harness'
    if (!options.loadAttachments) {
      return {
        blocks,
        problems: [
          `There is nowhere to read attachments from, so ${plural(attachments.length, 'attachment')} did not travel — only the message text went out.`,
        ],
      }
    }
    if (!supportsImagePrompt(session.selection)) {
      return {
        blocks,
        problems: [
          `${harness} did not advertise image prompts, so ${plural(attachments.length, 'attachment')} did not travel — only the message text went out.`,
        ],
      }
    }
    let loaded: readonly PromptAttachment[]
    try {
      loaded = await options.loadAttachments({
        sessionKey: session.selection.sessionKey,
        ids: attachments.map((attachment) => attachment.id),
      })
    } catch (error) {
      return {
        blocks,
        problems: [`Attachments could not be read, so the message went without them: ${errorMessage(error)}`],
      }
    }
    for (const attachment of loaded) {
      if (attachment.data && isImageMime(attachment.mimeType)) {
        blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType })
      }
    }
    const sent = blocks.length - 1
    return {
      blocks,
      problems:
        sent < attachments.length
          ? [`${plural(attachments.length - sent, 'attachment')} could not be sent as an image and did not travel.`]
          : [],
    }
  }

  async function deliverPrompt(
    sessionId: string,
    text: string,
    steerable = false,
    attachments: DeliveredAttachment[] = [],
  ): Promise<void> {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    // The delivery-time transform, if the host supplied one — applied here,
    // not by any caller of prompt(), so it sees the text at the one instant
    // it is truly handed to the harness.
    const deliveredText = options.transformDeliveredPrompt ? options.transformDeliveredPrompt(text) : text
    // Mid-turn message delivery goes through `_session/steering`: injected into
    // the running turn, whose own settlement stays the turn's end — no prompt
    // promise, no turn accounting. The gate here is the MECHANISM, not the
    // cadence: WHETHER this run may deliver now (realtime passes straight
    // through; every other cadence held it for a boundary/window) was already
    // decided upstream in `prompt`/`drainQueue`, so by the time a message run
    // reaches this point the only question left is HOW to hand it over. Steer
    // whenever the harness can take it, because a steer preserves the turn's
    // background subagents where a `session/cancel` would finish them
    // `cancelled`. Every other case falls through to the prompt below: a
    // forced-only adapter keeps the legacy overlapping session/prompt, a
    // system/command run (`steerable` false) must start its own turn rather
    // than become conversational input, and an `injected: false` answer means
    // the turn ended in the race window, where a normal prompt is simply
    // correct.
    //
    // The blocks are built once, whichever way the delivery goes: a steer that
    // falls back to a prompt hands over the same ones, and reading the
    // attachments twice would report each failure twice.
    let built: { blocks: ContentBlock[]; problems: string[] } | undefined
    if (steerable && session.activeTurns > 0 && supportsMidTurnInput(session.selection)) {
      built = await promptBlocks(session, deliveredText, attachments)
      const injected = await steerIntoRunningTurn(
        sessionId,
        session,
        deliveredText,
        built.blocks,
        attachments,
        built.problems,
      )
      if (injected) {
        return
      }
    }
    // Counted BEFORE anything below awaits. Until this line the session reads
    // as idle, and a send landing in an await here would dispatch a second
    // prompt over this one.
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
    built ??= await promptBlocks(session, deliveredText, attachments)
    const prompt = built.blocks
    emitDelivery(sessionId, deliveredText, attachments, built.problems)
    // The response's usage/quota/failure decorations are read here, at the one
    // place the prompt promise settles, so a host reads them off the turn_end
    // event instead of re-parsing `_meta` — none of it is spec-guaranteed
    // shape, and the parse rules live in one module (usage-meta).
    void connection.prompt({ sessionId, prompt }).then(
      (response) =>
        settleTurn(sessionId, {
          stopReason: response.stopReason,
          usage: normalizeTurnUsage(response.usage),
          quota: parseTurnQuota(response._meta),
          failure: parseSessionFailure(response._meta),
        }),
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
  // hands over what is next: held host notifications, then the next queued
  // prompt (see deliverAfterTurn). A failed settlement has already emitted its
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
    const attachments = runAttachments(run)
    // Returned rather than fired and forgotten, so a send into an IDLE session
    // can await its own dispatch. Every message goes through the queue now, and
    // without this a send that nothing was holding up would resolve before the
    // prompt had reached the harness — turning what used to be "delivered by
    // the time this resolves" into a race the caller cannot see. Drains from a
    // turn settlement have nobody waiting and keep discarding it.
    // Only a MESSAGE run may steer into a running turn: a system or command
    // entry (`/compact` above all) is harness machinery that must start its
    // own turn, never become conversational input to somebody else's.
    return deliverPrompt(sessionId, text, first.kind === 'message', attachments).then(
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
      // settlement drains whatever has come due by then. A windowed cadence
      // never steers (steersMidTurn wants `realtime`, which has no window),
      // so in practice this declines for every armed timer; the shared
      // predicate keeps the exception in one place should that ever move.
      if (session.activeTurns > 0 && !steersMidTurn(session)) {
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
  function toEntry(
    text: string,
    origin: PromptOrigin,
    attached: readonly PromptAttachmentInput[] = [],
  ): QueuedPrompt | null {
    // A picture with no words is still something sent; only an entry with
    // neither has nothing to say.
    if (text.trim().length === 0 && attached.length === 0) {
      return null
    }
    // Copied rather than kept, so a caller's array changing later cannot
    // change what an entry already holds.
    const carried = attached.map(({ id, name, mimeType, message }) => ({ id, name, mimeType, message: message ?? 0 }))
    const attachments = carried.length > 0 ? { attachments: carried } : {}
    if (origin.kind === 'system') {
      return { id: randomUUID(), kind: 'system', text, ...attachments }
    }
    // A leading slash marks a harness command, never a conversational message.
    // The harness recognises it by the prompt's FIRST characters — no trimming
    // on its side — so the entry stores the text with the leading whitespace
    // already gone, and delivery skips the tags and notes a message would get.
    // The entry keeps its author for the queue UI.
    const lead = text.trimStart()
    if (lead.startsWith('/')) {
      return {
        id: randomUUID(),
        kind: 'command',
        sender: origin.sender,
        sentAt: new Date().toISOString(),
        text: lead,
        ...attachments,
      }
    }
    return {
      id: randomUUID(),
      kind: 'message',
      sender: origin.sender,
      sentAt: new Date().toISOString(),
      text,
      ...attachments,
    }
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

  /**
   * What a run carries beside its text, each attachment marked with the message
   * of the delivery it came with. A message run's delivery is one message per
   * entry, in order, so an entry's position is its message; a system or command
   * run is its one entry, already positioned within its own body.
   */
  function runAttachments(run: QueuedPrompt[]): DeliveredAttachment[] {
    if (run[0].kind !== 'message') {
      return run[0].attachments ?? []
    }
    return run.flatMap((entry, index) =>
      (entry.attachments ?? []).map((attachment) => ({ ...attachment, message: index })),
    )
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

  function settleTurn(
    sessionId: string,
    outcome: {
      stopReason?: string
      /** The settled prompt's own usage/quota/failure, when the harness reported one. */
      usage?: TurnTokenUsage
      quota?: TurnQuota
      failure?: SessionFailure
    },
  ): void {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    session.activeTurns = Math.max(0, session.activeTurns - 1)
    if (session.activeTurns > 0) {
      return
    }
    // The turn boundary is the authoritative end of everything the turn
    // delegated: the harness holds the prompt open while its subagents run and
    // settles only once they have drained (or the turn was cancelled, which
    // finishes them itself with a terminal update). So a subagent still
    // lacking a terminal state HERE lost its state_update, not its life.
    // Reconciled off the boundary rather than a timer, so a stale record can
    // never pin "background work" — and with it the Working badge and the
    // idle-reaper guard — forever. Async tasks are left alone: their lifecycle
    // is genuinely detached from turns, and they carry their own terminal
    // states.
    for (const subagent of session.subagents?.values() ?? []) {
      if (subagent.state === undefined) {
        subagent.state = 'completed'
        emit(sessionId, { kind: 'subagent', subagent: { ...subagent } })
      }
    }
    // The turn boundary the usage_update case's monotonic rule promises
    // decreases for: apply the turn's true final reading now, even if it's
    // one that rule held back mid-turn. A no-op when the last applied
    // reading already matches (the common case — most turns never see a
    // held-back decrease at all). Merged onto the existing snapshot rather
    // than replacing it, so the cost/rate-limit state a side reading had
    // already merged in survives the boundary.
    if (
      session.pendingUsage &&
      (!session.usage ||
        session.pendingUsage.used !== session.usage.used ||
        session.pendingUsage.size !== session.usage.size)
    ) {
      session.usage = {
        ...(session.usage ?? {}),
        used: session.pendingUsage.used,
        size: session.pendingUsage.size,
      }
      emit(sessionId, usageEventOf(session.usage))
    }
    if (outcome.stopReason !== undefined) {
      // The model the turn actually ran on, resolved at the boundary rather
      // than read off the selection mirror — which is empty for a session
      // created without one (a group-chat thread) and stale after a live
      // switch. Preference order, most authoritative first: the largest model
      // in the harness's per-model quota breakdown (a real id that also names
      // the model when the selection never did), then the model config
      // option's current value (which a live switch DID update), then the
      // selection's own model.
      const quotaModel = largestQuotaModel(outcome.quota)
      const modelOption = findSelectOption(session.configOptions, MODEL_SELECTOR)
      const optionModel = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined
      const selectionModel = session.selection.model || undefined
      const resolvedModel = quotaModel ?? optionModel ?? selectionModel
      // The turn's OWN cost: the session's cumulative reading less what earlier
      // turns already claimed. A cumulative that dropped below the running
      // total is a compaction/conversation reset, and the fresh figure is then
      // the whole of this turn's spend. Tracked only at the boundary, so the
      // repeated mid-turn cost readings never double-count.
      let turnCost: SessionCost | undefined
      const cumulative = session.usage?.cost
      if (cumulative && Number.isFinite(cumulative.amount)) {
        const prior = session.costAccountedFor ?? 0
        const amount = cumulative.amount < prior ? cumulative.amount : cumulative.amount - prior
        session.costAccountedFor = cumulative.amount
        turnCost = { amount, currency: cumulative.currency }
      }
      emit(sessionId, {
        kind: 'turn_end',
        stopReason: outcome.stopReason,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.quota ? { quota: outcome.quota } : {}),
        ...(outcome.failure ? { failure: outcome.failure } : {}),
        adapterId: session.selection.adapterId,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(turnCost ? { cost: turnCost } : {}),
      })
    }
    if (session.pendingMcpRefresh) {
      session.pendingMcpRefresh = false
      // Everything the turn hands over waits for the resume, held
      // notifications included: a prompt started while it is in flight would
      // ride the very connection it is re-establishing.
      void performResumeSession(sessionId)
        .catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
        .then(() => deliverAfterTurn(sessionId))
      return
    }
    deliverAfterTurn(sessionId)
  }

  /**
   * What a settled turn hands over next: held notifications first, as a turn
   * of their own, and the queue only once THAT turn has settled.
   *
   * In that order because a notification is the application telling the agent
   * how work it started came out, and the messages waiting behind it are read
   * against that — a reader's "did the deploy go through?" is answered from
   * the notification, not guessed at ahead of it. Not in the same turn,
   * because the two are delivered differently: messages are tagged, batched
   * and noted, a notification goes verbatim, and one prompt cannot be both.
   */
  function deliverAfterTurn(sessionId: string): void {
    if (startNotificationTurn(sessionId)) {
      return
    }
    void drainQueue(sessionId)
  }

  /**
   * Deliver everything held for an IDLE session as one turn of its own. True
   * when a turn was started: the caller must then leave the queue alone,
   * because it drains when this turn settles.
   *
   * The turn is counted before this returns — deliverPrompt increments the
   * counter ahead of its first await — so nothing arriving in the same tick
   * can read the session as idle and start a second turn beside it.
   */
  function startNotificationTurn(sessionId: string): boolean {
    const session = store.sessions.get(sessionId)
    if (!session || session.activeTurns > 0) {
      return false
    }
    // A batch still out for a steer on an idle session is one whose turn
    // settled before the harness answered, and a turn that has ended cannot
    // take an injection (`idleBehavior: promptRequired`), so the answer on its
    // way is a refusal. Taken back here, ahead of anything held since, it
    // reaches the agent before the queue rather than behind whatever the
    // queue starts next. Should a harness inject anyway, the notification
    // arrives twice — the side at-least-once delivery is allowed to err on.
    if (session.notificationSteer) {
      session.notifications = [...session.notificationSteer, ...(session.notifications ?? [])]
      session.notificationSteer = undefined
    }
    if (!session.notifications?.length || options.shouldHoldDelivery?.() === true) {
      return false
    }
    const batch = session.notifications.splice(0)
    deliverPrompt(sessionId, batch.map((notification) => notification.text).join(NOTIFICATION_SEPARATOR)).then(
      // Issued — though if the session went away while its connection was
      // being found, the prompt went to a conversation nobody holds any more,
      // and the caller is better told it did not arrive.
      () => settleNotifications(batch, store.sessions.get(sessionId) === session),
      (error: unknown) => {
        emit(sessionId, { kind: 'error', message: errorMessage(error) })
        settleNotifications(batch, false)
      },
    )
    return true
  }

  /**
   * Put what is held into the RUNNING turn through the harness's steering
   * extension — whatever the session's cadence.
   *
   * Cadence is the reader's word about MESSAGES: how often they want to be
   * read. A notification is not written to the reader. It tells the agent that
   * work the agent itself started has ended, and holding that for a window, or
   * even for the end of the turn, leaves the agent working from a picture the
   * application already knows is out of date. So the only question is the one
   * steering always asks — can this harness take input mid-turn — and the
   * answer is always a steer, never `session/cancel`, which would finish the
   * turn's subagents as `cancelled` to deliver news about something else.
   *
   * Declined (the extension absent, the turn ending in the race window, the
   * request failing): the batch goes back to the front of what is held, and
   * the turn's own settlement delivers it. Not retried here: a harness that
   * just declined would decline again for the same reason, and the settlement
   * is coming either way.
   */
  async function steerNotifications(sessionId: string, session: SessionState): Promise<void> {
    const batch = (session.notifications ?? []).splice(0)
    session.notificationSteer = batch
    const text = batch.map((notification) => notification.text).join(NOTIFICATION_SEPARATOR)
    // The host's delivery-time transform, as deliverPrompt applies it on the
    // turn path: a notification must not read differently depending on which
    // of the two carried it.
    const deliveredText = options.transformDeliveredPrompt ? options.transformDeliveredPrompt(text) : text
    // A notification carries nothing beside its text, so its one block is
    // built here rather than through promptBlocks: there is nothing to read.
    const injected = await steerIntoRunningTurn(
      sessionId,
      session,
      deliveredText,
      [{ type: 'text', text: deliveredText }],
      [],
      [],
    )
    if (session.notificationSteer !== batch) {
      // Overtaken while the harness was answering: the turn settled first and
      // its settlement took the batch back to deliver as a turn, or the
      // session went away and answered for it. This answer decides nothing.
      return
    }
    session.notificationSteer = undefined
    if (!injected) {
      session.notifications = [...batch, ...(session.notifications ?? [])]
      return
    }
    settleNotifications(batch, true)
    // Anything that arrived while this one was out waited only because one
    // steer goes at a time; the turn that just took this one takes those too.
    offerNotifications(sessionId)
  }

  /**
   * Hand over what is held for a session by the only means its state allows
   * right now: a turn of its own when it is idle, a steer when a turn is
   * running on a harness that can take one, and otherwise nothing — the
   * running turn's settlement delivers it (deliverAfterTurn). Never through
   * the queue and never gated by the cadence; only the host's delivery gate
   * holds it.
   */
  function offerNotifications(sessionId: string): void {
    const session = store.sessions.get(sessionId)
    if (!session?.notifications?.length) {
      return
    }
    if (session.activeTurns === 0) {
      startNotificationTurn(sessionId)
      return
    }
    // One batch out at a time: a second steer racing the first could land the
    // two in the wrong order, and could not be taken back as one.
    if (
      options.shouldHoldDelivery?.() === true ||
      session.notificationSteer ||
      !supportsMidTurnInput(session.selection)
    ) {
      return
    }
    void steerNotifications(sessionId, session).catch((error: unknown) =>
      emit(sessionId, { kind: 'error', message: errorMessage(error) }),
    )
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
     *
     * Held host notifications go first, in the order a turn's settlement
     * keeps (see deliverAfterTurn): an idle session that has any gets them as
     * a turn of their own, and its queue drains when that turn settles.
     */
    resumeDelivery(): void {
      for (const [sessionId, session] of store.sessions) {
        if ((session.activeTurns ?? 0) > 0 || startNotificationTurn(sessionId)) {
          continue
        }
        if ((session.queue?.length ?? 0) > 0) {
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
    restoreUsage(
      sessionId: string,
      usage: { used: number; size?: number; cost?: SessionCost; rateLimits?: RateLimitWindow[] },
    ): void {
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
      const normalized = normalizeUsage(session.selection, usage)
      session.usage = {
        ...normalized,
        ...(usage.cost ? { cost: usage.cost } : {}),
        ...(usage.rateLimits ? { rateLimits: usage.rateLimits } : {}),
      }
      // A restored cumulative was already attributed, turn by turn, by the
      // process that recorded it. Without marking it accounted for, the first
      // boundary after a restart would difference against zero and hand the
      // whole history to one turn. A harness that restarts its own counter on
      // resume then reads as a reset at that boundary, which is the right
      // answer for that case too.
      if (usage.cost && Number.isFinite(usage.cost.amount)) {
        session.costAccountedFor = usage.cost.amount
      }
    },

    // Session keys (selection.sessionKey) of every session currently blocked on
    // the person: an unresolved permission request, or an unanswered question —
    // an elicitation the agent sent or one the host raised through askUser. The
    // two block a turn the same way, so a host badging "needs someone" reads
    // them as one state.
    awaitingUserSessionKeys(): string[] {
      const keys = new Set<string>()
      for (const { sessionId } of [...store.pendingPermissions.values(), ...store.pendingElicitations.values()]) {
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
    // of the awaiting-user state above (a turn blocked on a permission request
    // or a question is still in flight, so a session awaiting someone is in
    // both sets — the reads are separate so a host can tell them apart).
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

    // Session keys of every session with LIVE background work — a subagent or
    // async task still going with no turn active, the host's own tasks
    // (upsertAsyncTask) included.
    // hasActiveTurn/activeSessionKeys miss this by construction (no turn is
    // running), so a host reads it separately to hold the idle reaper off a
    // session that only looks idle, and to warn before stopping one.
    backgroundWorkSessionKeys(): string[] {
      const keys = new Set<string>()
      for (const [sessionId, session] of store.sessions) {
        const key = session.selection.sessionKey
        if (key && this.hasBackgroundWork(sessionId)) {
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

    // Whether the session has live background work its harness reported — a
    // subagent still running or a background task still running/paused. This
    // is work that keeps going with no turn active, so `hasActiveTurn` misses
    // it entirely: it is what lets a host warn before stopping a session and
    // hold the idle reaper off one that only LOOKS idle. Only what was
    // reported populates these — by a reporting harness, or by the host for
    // work it runs (upsertAsyncTask) — so a harness that says nothing reads as
    // no background work: the same honest blank as before the feature.
    hasBackgroundWork(sessionId: string): boolean {
      const session = store.sessions.get(sessionId)
      return session ? hasLiveBackgroundWork(session) : false
    },

    /**
     * Report a background task the HOST runs on a session's behalf — a build,
     * a deploy — in the same record the harness's own tasks live in.
     *
     * Everything downstream reads that record and nothing else, so emitting it
     * is the whole integration: the session reads as working while the task
     * runs (hasBackgroundWork and backgroundWorkSessionKeys, and with them a
     * host's idle guard), a transcript or a background-task view draws it, a
     * host recording events through onEvent records it, and a restored session
     * folds it back. A second path for host work would be a second copy of
     * each of those, and the first new consumer would read only one of them.
     *
     * `origin` is forced to `'host'`: it is what sends stopAsyncTask to
     * stopHostTask rather than to a harness that has never heard of the task.
     *
     * The record REPLACES whatever was there, where the harness path merges.
     * The protocol sends partial updates, so that path has to patch; the host
     * owns the whole record and reports it whole, so a field it leaves out is
     * a field it cleared.
     *
     * False when the session is not in memory: nothing would hold the record,
     * and a host reporting into a session that is gone has to know it did not
     * land.
     */
    upsertAsyncTask(sessionId: string, task: AsyncTaskInfo): boolean {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return false
      }
      // A copy, nested usage included: the stored record and the logged event
      // must not alias an object the host goes on mutating.
      const record: AsyncTaskInfo = {
        ...task,
        ...(task.usage ? { usage: { ...task.usage } } : {}),
        origin: 'host',
      }
      session.asyncTasks ??= new Map()
      session.asyncTasks.set(record.asyncTaskId, record)
      emit(sessionId, { kind: 'async_task', task: { ...record } })
      return true
    },

    // Stop ONE background task without cancelling the prompt turn. A task the
    // host runs (`origin: 'host'`, see upsertAsyncTask) goes to the host's
    // stopHostTask and never to the harness, which has never heard of it.
    // Every other task — including an id this session holds no record of —
    // goes over the harness's `_session/async_task/stop` extension, as it
    // always has. A no-op (resolving false) when the session or the owner's
    // channel is absent (no stopHostTask, no connection, no extension) — the
    // same degrade-quietly contract steering follows.
    async stopAsyncTask(sessionId: string, asyncTaskId: string): Promise<boolean> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return false
      }
      if (session.asyncTasks?.get(asyncTaskId)?.origin === 'host') {
        if (!options.stopHostTask) {
          return false
        }
        try {
          return await options.stopHostTask({ sessionId, sessionKey: session.selection.sessionKey, asyncTaskId })
        } catch (error) {
          emit(sessionId, { kind: 'error', message: errorMessage(error) })
          return false
        }
      }
      const entry = connEntryFor(session.selection)
      if (typeof entry?.connection.extMethod !== 'function') {
        return false
      }
      try {
        await entry.connection.extMethod('_session/async_task/stop', { sessionId, asyncTaskId })
        return true
      } catch (error) {
        emit(sessionId, { kind: 'error', message: errorMessage(error) })
        return false
      }
    },

    // Session keys of every session with a *live agent process* right now —
    // i.e. present in `store.sessions` at all, whether idle, working, or
    // awaiting someone. A restarted server (or a session ended via
    // deleteSession without a matching close) has none until the tab's
    // session is next opened — see openLocalSession's cold-start resume.
    // Lets a host show "process alive" independent of activeSessionKeys
    // (working) and awaitingUserSessionKeys (blocked).
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
        // The native harness rewinds its own message store; an external ACP
        // agent forks its own transcript when it advertised `session/fork` —
        // its word, read at initialize (see forkSession).
        canFork: native || connEntryFor(selection)?.forkSupported === true,
        adapterId: selection.adapterId,
        model: selection.model,
        sessionKey: selection.sessionKey,
      }
      putSession(sessionId, {
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
        const option = findSelectOption(response.configOptions, THOUGHT_LEVEL_SELECTOR)
        const value = option ? matchReasoningValue(option.options, effort) : undefined
        if (option && value) {
          await this.setConfigOption(sessionId, option.id, value).catch((error: unknown) =>
            emit(sessionId, { kind: 'error', message: errorMessage(error) }),
          )
        }
      }
      // Apply the selected model the same way, for ACP agents whose adapter
      // declares no modelEnv (OpenCode, Codex): there is no env var to carry
      // the choice, so without this the session starts on whatever the
      // harness last used and the profile's model is silently ignored. A
      // model that doesn't resolve to one of the advertised options leaves
      // the harness default rather than guessing — see matchModelValue — and
      // says so in the chat: a silent skip here is how an unconfigured
      // provider used to hide, the session just running on the harness's
      // own pick.
      if (!native && selection.model && !findAdapter(selection.adapterId)?.modelEnv && response.configOptions) {
        const option = findSelectOption(response.configOptions, MODEL_SELECTOR)
        if (option) {
          const value = matchModelValue(option.options, selection.model)
          if (value && value !== option.currentValue) {
            await this.setConfigOption(sessionId, option.id, value).catch((error: unknown) =>
              emit(sessionId, { kind: 'error', message: errorMessage(error) }),
            )
          } else if (!value) {
            const offered = selectOptionValues(option.options)
              .map((entry) => entry.value)
              .filter((entry): entry is string => typeof entry === 'string')
            const list = offered.length > 8 ? `${offered.slice(0, 8).join(', ')} … (${offered.length} offered)` : offered.join(', ')
            emit(sessionId, {
              kind: 'error',
              message: `Model "${selection.model}" is not offered by ${
                findAdapter(selection.adapterId)?.label ?? 'this harness'
              }${list ? ` (${list})` : ' (no models advertised)'}. The session keeps the harness's default — set the profile model to one of the offered ids, or configure the missing provider.`,
            })
          }
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
        // Same resolution as createSession: the agent's advertised
        // `session/fork`, not the fact that history was replayed.
        canFork: entry.forkSupported === true,
        adapterId: selection.adapterId,
        model: selection.model,
        sessionKey: selection.sessionKey,
      }
      // Register the session record BEFORE the replay: the agent streams its
      // history as session/update notifications, and emit()/subscribe() drop
      // events for an unknown session id.
      putSession(sessionId, {
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
        // so the caller can cleanly create a fresh one. A notification the host
        // issued into it while the gate held it is answered, not stranded.
        releaseNotifications(store.sessions.get(sessionId))
        dropSession(sessionId)
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

    /**
     * Reopen a session from a transcript the HOST kept, reattaching the agent
     * without asking it to replay history.
     *
     * The alternative, `loadSession`, asks the harness for the conversation and
     * rebuilds the transcript from what comes back. That makes the UI's memory
     * only as good as the harness's replay, and a replay can be lossy in ways
     * nothing reports: it carries what the harness chose to persist, in the
     * shape it chose to persist it, and whatever it leaves out is simply
     * missing from the reopened chat with no gap where it used to be.
     *
     * This path inverts the dependency. The host has already seen every event
     * as it happened — that is what `onEvent` is for — so a host that keeps
     * them owns a transcript that is exactly what was shown the first time.
     * What it cannot keep is the AGENT, and that is all `session/resume` is
     * asked for here: the model's own context comes back from the harness's
     * own store, and no history crosses the wire.
     *
     * Returns null when this cannot be done — a native selection, or an agent
     * that does not advertise the resume capability — so a caller falls back to
     * `loadSession` rather than losing the conversation. Both paths are kept
     * because they fail differently: without a log there is nothing to restore
     * FROM, and the harness's imperfect replay is much better than an empty
     * chat.
     *
     * `events` is seeded by assignment, never re-emitted. Emitting would hand
     * every restored event straight back to `onEvent`, and a host storing them
     * would write its own log back into itself on every reopen.
     */
    async restoreSession(
      sessionId: string,
      selection: AgentSelection,
      events: readonly ChatEvent[],
      permissions?: ResolvedPermissions,
    ): Promise<SessionMeta | null> {
      if (isNativeSelection(selection)) {
        return null
      }
      const connection = await ensureConnection(selection)
      const entry = connEntryFor(selection)
      if (!entry?.resumeSession) {
        return null
      }
      // Mint a per-session MCP token before reattaching, mirroring createSession
      // and loadSession — the resumed agent lists tools against this session's
      // permissions, not the previous process's.
      let token: string | null = null
      let mcpServers: AcpMcpServer[] = []
      if (supportsTools(selection)) {
        const { internal, servers } = await buildMcpServers(selection)
        token = randomUUID()
        store.acpTokenPermissions.set(token, permissions)
        store.acpTokenSession.set(token, sessionId)
        mcpServers = tagInternal(internal, servers, token)
      }
      const restored = restorableEvents(events)
      const state = foldRestoredState(restored)
      store.titleCounter += 1
      const restoredAt = Date.now()
      const meta: SessionMeta = {
        id: sessionId,
        title: state.title ?? `New chat ${store.titleCounter}`,
        createdAt: restoredAt,
        lastActivityAt: restoredAt,
        // Same resolution as loadSession below it: the agent's advertised
        // `session/fork`, not the fact that history was rebuilt. This is the
        // path every OLD conversation reopens through (the recorded transcript
        // exists), so hardcoding false here hid the fork capability from every
        // session that predates it.
        canFork: entry.forkSupported === true,
        sessionKey: selection.sessionKey,
      }
      putSession(sessionId, {
        meta,
        selection,
        events: restored,
        subscribers: new Set(),
        modes: state.modes,
        configOptions: state.configOptions,
        commands: state.commands,
        compactions: state.compactions,
        subagents: state.subagents,
        asyncTasks: state.asyncTasks,
        ...(state.plan ? { plan: state.plan } : {}),
        permissions,
        activeTurns: 0,
        // Not folded from the log: the durable queue and the reading cadence
        // are restored from their own stores by restoreSessionState below, and
        // a queue recovered from a transcript would be the one the process was
        // holding before it delivered them. See restorableEvents.
        queue: [],
        presence: DEFAULT_PRESENCE,
        ...(state.usage ? { usage: state.usage } : {}),
      })
      // Subagents route by a module-level map rather than off the session, so
      // restoring the records is not enough: without this a chunk arriving from
      // a subagent that is STILL RUNNING has no parent to nest under and is
      // dropped, which is the live half of the same loss this path exists to
      // close.
      for (const subagentSessionId of state.subagents.keys()) {
        store.subagentParents.set(subagentSessionId, sessionId)
      }
      try {
        await connection.resumeSession({ sessionId, cwd: selection.cwd, mcpServers })
      } catch (error) {
        // The agent could not take the session back — unwind the half-registered
        // record so the caller can cleanly fall back to a replay or a fresh
        // session, exactly as loadSession does, held notifications included.
        releaseNotifications(store.sessions.get(sessionId))
        dropSession(sessionId)
        for (const subagentSessionId of state.subagents.keys()) {
          store.subagentParents.delete(subagentSessionId)
        }
        if (token) {
          store.acpTokenSession.delete(token)
          store.acpTokenPermissions.delete(token)
        }
        throw error
      }
      // After the reattach, for the reason loadSession restores after its
      // replay: a drain must not deliver into a session the agent has not
      // taken back yet.
      await restoreSessionState(sessionId)
      // A log that ends mid-turn is a session whose process stopped while it
      // was working, and nothing is coming to close it — the client would sit
      // "waiting" forever on a turn that ended when the process did. A log that
      // already ends on a boundary needs nothing, which is also what makes
      // reopening the same session twice idempotent.
      //
      // Read off what was RECORDED rather than off the seeded array: the
      // closures restorableEvents appends are bookkeeping about a dead process,
      // and letting them stand as the transcript's tail would both hide a
      // boundary that is there and report every such session as interrupted.
      const tail = events.at(-1)
      if (tail?.kind !== 'turn_end') {
        emit(sessionId, {
          kind: 'turn_end',
          stopReason: endsOnSettledWork(lastConversationEvent([...events])) ? 'replayed' : 'resumed',
        })
      }
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
      // Read again rather than taken from the top: the close above is awaited,
      // and a notification the host issued meanwhile is held on the record
      // being dropped now.
      releaseNotifications(store.sessions.get(sessionId))
      dropSession(sessionId)
      store.nativeSessions.delete(sessionId)
      dropSessionTokens(sessionId)
      // Drop the subagent→parent routes this session owned, so a later
      // session id can't be misrouted as one of its subagents.
      for (const [childId, parentId] of store.subagentParents) {
        if (parentId === sessionId) {
          store.subagentParents.delete(childId)
        }
      }
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
    userTurnAt(
      sessionId: string,
      eventIndex: number,
    ): { text: string; attachments: DeliveredAttachment[]; turnIndex: number } | null {
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
      return { text: event.text, attachments: event.attachments ?? [], turnIndex }
    },

    // Branch a session into a new one, rewound to a turn (dropFromTurn, 0-based;
    // defaults to the last turn). The native harness rewinds its own message
    // store; an external ACP agent forks its own transcript when it advertised
    // `session/fork` at initialize, with our turn cutoff translated into its
    // fork-point dialect (see forkCutoffMeta).
    //
    // `opts.sessionKey` binds the fork to a key of the caller's choosing — the
    // host's address for the conversation the fork is about to be. With it, the
    // fork's events record under that key and a reopen rebuilds it; without it
    // the fork stays keyless, reachable only through the id this returns.
    //
    // NAMING ONE IS THE NORMAL CASE, for both flows that fork: a fork that
    // becomes its own conversation is named with the key minted for it, and an
    // adopt-in-place edit is named with the key of the tab that is about to
    // adopt it. An unnamed fork records nothing anywhere, which is only ever
    // right for a fork nothing will reopen.
    //
    // What is deliberately absent is INHERITANCE, not naming — see the meta
    // note below on why the source's key never carries over on its own. (This
    // used to say an unnamed fork "is what the adopt-in-place edit flow wants".
    // It was: that flow had no persistence stake, until it turned out the tab
    // it hands the fork to goes on recording under its key.)
    async forkSession(
      sessionId: string,
      dropFromTurn?: number,
      opts?: { sessionKey?: string },
    ): Promise<SessionMeta | null> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return null
      }
      const native = isNativeSelection(session.selection)
      // THE CONNECTION FIRST, THEN ITS CAPABILITY. `forkSupported` is written
      // by the initialize handshake, so it only exists on an entry that has
      // one — and a session outlives its process: the idle reaper stops a quiet
      // agent, and a harness that exits drops its entry. Reading the capability
      // before ensuring the connection therefore answered "no such entry" for a
      // session whose agent was merely not running, and reported an agent that
      // forks perfectly well as one that cannot fork at all. A reader saw
      // `Internal error` on an edit, minutes after editing worked.
      const connection = await ensureConnection(session.selection)
      const entry = native ? undefined : connEntryFor(session.selection)
      if (!native && entry?.forkSupported !== true) {
        throw new Error('Forking is only supported by the in-process native harness.')
      }
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
      const response = native
        ? await connection.unstable_forkSession({
            sessionId,
            cwd: session.selection.cwd,
            mcpServers: [],
            _meta: dropFromTurn === undefined ? undefined : { dropFromTurn },
          })
        : await forkExternalSession(session, entry, boundary)
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
        // The fork runs on the source session's selection, so the harness and
        // model mirrors carry over — they describe the spawn, not the tab.
        adapterId: session.selection.adapterId,
        model: session.selection.model,
        // The caller's key for the fork's own conversation, when one was
        // named. Deliberately NOT inherited from the source session otherwise:
        // a fork is reached through its own tab, never through the original
        // sessionKey (see forkLocal in acp.ts), so carrying the key forward
        // would make a sessionKey -> session lookup ambiguous between the two.
        sessionKey: opts?.sessionKey,
      }
      putSession(response.sessionId, {
        meta,
        // A keyed fork is a different conversation to the key-based reads, so
        // its selection carries ITS key; an unkeyed one shares the source's
        // selection object, as it always has.
        selection: opts?.sessionKey ? { ...session.selection, sessionKey: opts.sessionKey } : session.selection,
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
      opts: {
        front?: boolean
        queue: QueueMode
        origin: PromptOrigin
        // What the prompt carries beside its text -- see attachments.ts. A
        // position is only meaningful for a system prompt that is already a
        // finished delivery body (an edit's re-send); anything else is one
        // message, and its attachments are that message's.
        attachments?: readonly PromptAttachmentInput[]
      },
    ): Promise<{ interrupted: boolean }> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return { interrupted: false }
      }
      // Session records that survived a dev hot-reload may predate the queue
      // fields (the store outlives createStore); backfill in place.
      session.queue ??= []
      session.activeTurns ??= 0

      // Under a realtime cadence a steering-capable agent never queues: the
      // prompt goes straight through and the live turn picks it up as
      // streaming input, so there is nothing to batch and nothing worth
      // interrupting. Every other cadence holds even on such an agent — the
      // reader chose a boundary, and capability is not consent.
      const holding = session.activeTurns > 0 && !steersMidTurn(session)
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

      const entry = toEntry(text, opts.origin, opts.attachments)
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
        if (!holding || supportsMidTurnInput(session.selection)) {
          // Steer the held queue into the running turn rather than cancelling
          // it: `session/cancel` finishes the turn's background subagents as
          // `cancelled` (verified in the bridge), and a queue push must never
          // be what kills a delegation. The drain reaches the steer path
          // (deliverPrompt) with the turn still live; nothing is interrupted.
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
      if (supportsMidTurnInput(session.selection)) {
        // Steer instead of cancelling — see the empty-push branch above: a push
        // must not finish the turn's subagents, which `session/cancel` would.
        await drainQueue(sessionId)
        return { interrupted: false }
      }
      await cancelSession(sessionId)
      return { interrupted: true }
    },

    /**
     * Tell the agent something the APPLICATION knows about work the agent
     * itself started — "your background build finished" — as opposed to
     * something somebody wrote to it.
     *
     * That difference decides every rule here. A message is written to be
     * read at the reader's pace, so it waits in the queue, shows as unread and
     * is held by Presence. A notification is none of those: nobody wrote it,
     * nobody is waiting to see it read, and holding it leaves the agent
     * working from a picture the application already knows is stale. So it
     * never enters the queue — not the in-memory one, not the durable store,
     * not a `queue` snapshot, not the unread list — and no cadence holds it:
     *
     *  - a turn is running on a harness that takes mid-turn input: it goes
     *    into that turn now, by steering, and never by `session/cancel`, which
     *    would finish the turn's subagents as `cancelled`;
     *  - a turn is running that cannot take it (no steering, or the steer was
     *    declined): it is held, and delivered the moment that turn settles,
     *    as a turn of its own and ahead of the queue — which drains when the
     *    notification's turn settles in turn. Several held notifications go
     *    as one prompt;
     *  - nothing is running: it goes now, as a new turn.
     *
     * Only the host's delivery gate holds it, as it holds everything
     * (shouldHoldDelivery), and resumeDelivery() lets it go.
     *
     * Verbatim, like a system entry: no queue tag, no delivery note. It still
     * arrives as an ordinary `user` event, because that event is the turn
     * boundary a transcript folds on; keeping the text out of a reader's way
     * is the host's job, through markup of its own.
     *
     * Resolves true once the text is handed to the harness — the steer
     * accepted, or its session/prompt issued; the turn itself is never waited
     * for — and false when the session goes away first: dropped, reset, or
     * never known here. That answer is built for at-least-once delivery: a
     * caller marks its work delivered on true and tries again later on false,
     * which is why a held notification is answered, never stranded, when its
     * session disappears.
     */
    notify(sessionId: string, text: string): Promise<boolean> {
      const session = store.sessions.get(sessionId)
      // Nothing to say is not a notification: the prompt would start a turn
      // saying nothing. False rather than true, because true tells the caller
      // something reached the agent.
      if (!session || text.trim().length === 0) {
        return Promise.resolve(false)
      }
      return new Promise<boolean>((settle) => {
        session.notifications ??= []
        session.notifications.push({ text, settle })
        offerNotifications(sessionId)
      })
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

    // The session a pending permission request or question was raised in, or
    // undefined once it is answered or if it never existed — so a host can
    // decide who may answer it before it does.
    pendingRequestSessionId(requestId: string): string | undefined {
      return (store.pendingPermissions.get(requestId) ?? store.pendingElicitations.get(requestId))?.sessionId
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
    subscribe(
      sessionId: string,
      subscriber: Subscriber,
      opts?: {
        fromIndex?: number
        /**
         * How many of the replayed events came from the snapshot prefix rather
         * than from the log, reported before the first of them is delivered.
         *
         * A caller that NUMBERS the replay needs this, and the number is not
         * derivable at the far end: a prefixed `queue` event and a logged one
         * are the same object, so a receiver counting positions from
         * `fromIndex` puts every real event `snapshotPrefix` slots too high.
         * Which is silent — until something addresses an event by its position
         * (an edit, a fork) and reaches a different one, or none.
         */
        onReplay?: (info: { snapshotPrefix: number }) => void
        /**
         * Called once when this subscription ends because its session did —
         * dropped (deleted, stopped, unloaded) or replaced by a reopen under the
         * same id. Nothing arrives after it; a reader that wants the session
         * back opens it again and subscribes to what that gives. Called at once
         * for an unknown session, which is the same situation. Not called for an
         * unsubscribe the caller made itself.
         */
        onEnd?: () => void
      },
    ): () => void {
      const session = store.sessions.get(sessionId)
      if (!session) {
        opts?.onReplay?.({ snapshotPrefix: 0 })
        opts?.onEnd?.()
        return () => {}
      }
      const from = opts?.fromIndex ?? 0
      const windowed = from > 0 ? session.events.slice(from) : session.events
      const replay = withSnapshotPrefix(session, windowed)
      // Before the first event goes out, so a subscriber that has to know the
      // offset knows it while it is still reading the replay.
      opts?.onReplay?.({ snapshotPrefix: replay.length - windowed.length })
      for (const event of replay) {
        subscriber(event)
      }
      session.subscribers.add(subscriber)
      if (opts?.onEnd) {
        session.subscriberEnds ??= new Map()
        session.subscriberEnds.set(subscriber, opts.onEnd)
      }
      return () => {
        session.subscribers.delete(subscriber)
        session.subscriberEnds?.delete(subscriber)
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

    // The session's whole event log, in order — the read side of the durable-
    // transcript seam (a host records events as they arrive; this hands back
    // what it would have recorded for a session that arrived already built, a
    // fork above all). Null for an unknown session. Not a paging window: a
    // caller seeding a store wants all of it, and a bounded tail is what
    // getRecordsWindow is for.
    getSessionEvents(sessionId: string): ChatEvent[] | null {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return null
      }
      return [...session.events]
    },

    // A native session's conversation, in the package's own record type.
    //
    // The event log is the transcript a reader sees; this is what the model was
    // actually sent, and it is what another completion has to be given to carry
    // the same conversation on. Null for an unknown session and for an ACP one:
    // a subprocess owns its history and never hands it over.
    chatHistory(sessionId: string): ChatMessageRecord[] | null {
      const native = store.nativeSessions.get(sessionId)
      return native ? toChatMessages(native.messages) : null
    },

    async reset(): Promise<void> {
      for (const entry of store.connections.values()) {
        entry.process?.kill()
      }
      store.connections.clear()
      for (const session of store.sessions.values()) {
        releaseNotifications(session)
        endSubscriptions(session)
      }
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
