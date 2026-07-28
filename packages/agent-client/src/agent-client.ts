import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'

import type {
  McpServer as AcpMcpServer,
  Client,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
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
import { errorMessage } from './errors'
import { readMcpConfig, resolveMcpServers } from './mcp-config'
import { createMcpServer, type SkillHandler, type SkillsInput, type ToolsInput } from './mcp-server'
import type { McpServerConfig } from './mcp-types'
import { createNativeHarness, type NativeHarnessConfig, type NativeSession } from './native-harness'
import {
  type EventsWindow,
  pageBeforeByRecords,
  pageBeforeByTurns,
  type RecordsWindow,
  tailByRecords,
  tailByTurns,
} from './pagination'
import { type ResolvedPermissions, toolKey } from './permissions'
import { buildSpawnConfig, containerReachableMcpUrl, findAdapter } from './resolve'
import { fileSkillHandler, fileSkills } from './skills'
import { findTurnBoundary } from './turns'
import type { AgentSelection, ChatEvent, QueuedPrompt, SessionMeta, SessionMode, SpawnConfig } from './types'

export interface ClientInfo {
  name: string
  version: string
}

// What the host decides to do with an ACP permission request:
//  - 'allow':  resolve it as approved without prompting the user.
//  - 'deny':   resolve it as rejected without prompting the user.
//  - 'prompt': surface it to the chat UI for the user to decide (the default).
export type PermissionOutcome = 'allow' | 'deny' | 'prompt'

export interface PermissionContext {
  sessionId: string
  // The ACP tool-call title (best-effort tool name).
  toolName: string
  // The ACP tool-call kind (e.g. 'read' | 'edit' | 'execute'), when the agent
  // provides one — lets the host auto-approve read-only kinds, etc.
  toolKind?: string
}

export type PermissionHandler = (context: PermissionContext) => PermissionOutcome | Promise<PermissionOutcome>

export interface AgentClientOptions {
  mcpServerName?: string
  tools?: ToolsInput
  skills?: SkillsInput
  skillHandler?: SkillHandler
  // Always-on MCP servers injected into every session, in addition to the
  // built-in local server and the user-configured ones.
  extraMcpServers?: AcpMcpServer[]
  // Source the user-configured MCP servers (defaults to reading mcp-config.json).
  // Lets a host store them elsewhere, e.g. a database, instead of on disk.
  loadMcpServers?: () => Promise<McpServerConfig[]>
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
  // True only while session/load is replaying this session's history. The
  // replay carries no turn boundaries of its own, so handleUpdate reconstructs
  // them while this is set — see the `user_message_chunk` case.
  replaying?: boolean
  // Set by a flushing prompt (see prompt's `flush`) while a turn is still
  // running. The next drain then hands the WHOLE queue over as one delivery
  // instead of one entry, and clears this. Held as state rather than passed to
  // the drain because the two are separated in time: the flush is requested
  // while the turn it interrupts is still settling.
  flushQueue?: boolean
  // Last usage_update seen, mirrored here (like modes/configOptions/queue) so
  // a windowed subscribe/getEventsWindow can synthesize it without scanning
  // history — see the SNAPSHOT_KINDS handling below.
  usage?: { used: number; size?: number }
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
  if (session.meta.title && !has('session_info')) {
    prefix.push({ kind: 'session_info', title: session.meta.title })
  }
  if (session.usage && !has('usage')) {
    prefix.push({ kind: 'usage', used: session.usage.used, size: session.usage.size })
  }
  if (session.queue.length > 0 && !has('queue')) {
    prefix.push({ kind: 'queue', items: [...session.queue] })
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
      // the previous event was not itself a user chunk — otherwise a message
      // split across two chunks would be reported as two turns.
      const session = store.sessions.get(sessionId)
      if (session?.replaying && session.events.at(-1) && session.events.at(-1)?.kind !== 'user') {
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
      // size <= 0 means the agent couldn't determine the context window.
      const size = update.size > 0 ? update.size : undefined
      const session = store.sessions.get(sessionId)
      if (session) {
        session.usage = { used: update.used, size }
      }
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
// surface to the user.
function buildClient(getElicitationSession: () => string | null, permissionHandler?: PermissionHandler): Client {
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
      const outcome = permissionHandler
        ? await permissionHandler({
            sessionId: request.sessionId,
            toolName: title,
            toolKind: request.toolCall.kind ?? undefined,
          })
        : 'prompt'
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
    unstable_createElicitation: (request: CreateElicitationRequest) =>
      new Promise<CreateElicitationResponse>((resolve) => {
        const sessionId = getElicitationSession() ?? store.lastSessionId
        if (!sessionId) {
          resolve({ action: 'cancel' })
          return
        }
        const requestId = randomUUID()
        store.pendingElicitations.set(requestId, { sessionId, resolve })
        emit(sessionId, {
          kind: 'ask_user',
          requestId,
          message: request.message,
        })
      }),
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

export function createAgentClient(options: AgentClientOptions = {}) {
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
  })

  // The real MCP servers the native harness should attach in-process — the
  // configured ones plus any extras, but NOT the built-in local server (its
  // tools/skills already run in-process). Re-evaluated per turn.
  async function loadNativeMcpServers(): Promise<AcpMcpServer[]> {
    const configured = options.loadMcpServers ? await options.loadMcpServers() : await readMcpConfig()
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
    const configured = options.loadMcpServers ? await options.loadMcpServers() : await readMcpConfig()
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
      buildClient(() => store.lastSessionId, options.permissionHandler),
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
    child.stderr.on('data', (chunk: Buffer) => {
      console.error('[acp-agent]', chunk.toString())
    })
    // Without an 'error' listener a failed spawn throws at the process level and
    // takes the host server down; handle it so the failure surfaces as a rejected
    // initialize()/prompt() instead.
    child.on('error', (error) => {
      console.error('[acp-agent] spawn failed:', error)
      store.connections.delete(key)
    })
    child.on('exit', () => {
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
      () => buildClient(() => entry.lastSessionId, options.permissionHandler),
      stream,
    )
    entry = { process: child, connection, lastSessionId: null, loadSession: false, initialized: Promise.resolve() }
    store.connections.set(key, entry)
    entry.initialized = (async () => {
      const initResult = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          elicitation: {},
        },
        clientInfo,
      })
      entry.loadSession = Boolean(
        (initResult as { agentCapabilities?: { loadSession?: boolean } }).agentCapabilities?.loadSession,
      )
    })()
    await entry.initialized
    return connection
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
    emit(sessionId, { kind: 'queue', items: [...queue] })
  }

  // Frame several held messages into the single prompt a flush delivers. They
  // have to stay individually readable: a flush exists so the agent can see
  // everything still pending BEFORE it acts, which fails if the messages run
  // together into one instruction. Numbering makes their order explicit, so a
  // later message can correct an earlier one and be understood as doing that.
  //
  // One message is returned untouched — a flush against an empty queue must
  // read exactly like an ordinary send, with no framing to explain.
  function joinPrompts(texts: string[]): string {
    if (texts.length < 2) {
      return texts[0] ?? ''
    }
    return texts.map((text, i) => `[message ${i + 1} of ${texts.length}]\n${text}`).join('\n\n')
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
    emit(sessionId, { kind: 'user', text })
    void connection.prompt({ sessionId, prompt: [{ type: 'text', text }] }).then(
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
  function settleTurn(sessionId: string, outcome: { stopReason?: string }): void {
    const session = store.sessions.get(sessionId)
    if (!session) {
      return
    }
    session.activeTurns = Math.max(0, session.activeTurns - 1)
    if (session.activeTurns > 0) {
      return
    }
    if (outcome.stopReason !== undefined) {
      emit(sessionId, { kind: 'turn_end', stopReason: outcome.stopReason })
    }
    // A flush requested mid-turn (see prompt's `flush`) drains EVERYTHING as
    // one delivery rather than one entry per turn. This is the point where it
    // can happen without racing the turn it interrupted: that turn has just
    // settled, so nothing is in flight. Draining one-per-turn here would defeat
    // the flush — the agent would act on each stale message before reaching the
    // newest one, which is the whole reason a flush was asked for.
    if (session.flushQueue) {
      session.flushQueue = false
      const pending = session.queue ?? []
      if (pending.length === 0) {
        return
      }
      const text = joinPrompts(pending.map((item) => item.text))
      session.queue = []
      emitQueue(sessionId, session.queue)
      void deliverPrompt(sessionId, text).catch((error: unknown) =>
        emit(sessionId, { kind: 'error', message: errorMessage(error) }),
      )
      return
    }
    const next = session.queue?.shift()
    if (!next) {
      return
    }
    emitQueue(sessionId, session.queue)
    void deliverPrompt(sessionId, next.text).catch((error: unknown) =>
      emit(sessionId, { kind: 'error', message: errorMessage(error) }),
    )
  }

  return {
    listSessions(): SessionMeta[] {
      return [...store.sessions.values()].map((session) => session.meta).sort((a, b) => a.createdAt - b.createdAt)
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

    // The host's registered LocalTools (for role-permission editors). Resolves
    // a dynamic tools source (e.g. live agent-tool graph nodes) same as a turn
    // would. Per-session MCP and skill tools are separate and not listed here.
    async listTools(): Promise<{ name: string; description: string }[]> {
      const tools = options.tools ?? []
      const resolved = typeof tools === 'function' ? await tools() : tools
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
        permissions,
        activeTurns: 0,
        queue: [],
      })
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
        permissions,
        activeTurns: 0,
        queue: [],
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
      // The replay streams history but no turn boundary, so the client would stay
      // stuck "waiting". A terminal turn_end marks the resumed session idle.
      //
      // This one closes the LAST replayed turn, and keeps `resumed` rather than
      // the `replayed` marker the earlier boundaries carry: it is the only turn
      // the restart could have cut off mid-flight, since every other replayed
      // turn is followed by a prompt that proves it ended. Reporting it as
      // interrupted keeps a genuinely severed turn distinguishable.
      emit(sessionId, { kind: 'turn_end', stopReason: 'resumed' })
      return meta
    },

    async resumeSession(sessionId: string): Promise<void> {
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
    },

    async refreshMcpServers(): Promise<void> {
      for (const sessionId of store.sessions.keys()) {
        await this.resumeSession(sessionId).catch((error: unknown) =>
          emit(sessionId, { kind: 'error', message: errorMessage(error) }),
        )
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
        permissions: session.permissions,
        activeTurns: 0,
        queue: [],
      })
      return meta
    },

    // `flush` turns this into a push: everything already held for the session
    // is delivered together with this message, in the order it was sent and
    // with this one last, as ONE turn. Callers use it after interrupting an
    // in-flight turn, so the agent reads the full picture before acting rather
    // than working through each stale message first. Ordinary sends are
    // untouched: still one message per turn, drained as turns end.
    async prompt(sessionId: string, text: string, opts?: { front?: boolean; flush?: boolean }): Promise<void> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return
      }
      // Session records that survived a dev hot-reload may predate the queue
      // fields (the store outlives createStore); backfill in place.
      session.queue ??= []
      session.activeTurns ??= 0
      // A running turn normally means the message must wait: ACP takes one
      // prompt-turn at a time, so it's held here (server-side, surviving the
      // client that typed it) and the snapshot published. `front` puts it
      // ahead of earlier queued messages, e.g. corrective guidance after a
      // rejected permission that must reach the agent before anything else.
      // Steering-capable agents (see supportsMidTurnInput) skip the queue
      // entirely: the prompt goes straight through and the live turn picks it
      // up as streaming input.
      if (session.activeTurns > 0 && !supportsMidTurnInput(session.selection)) {
        const item: QueuedPrompt = { id: randomUUID(), text }
        if (opts?.front) {
          session.queue.unshift(item)
        } else {
          session.queue.push(item)
        }
        // Held, not delivered: the interrupted turn has not settled yet. The
        // flag makes the drain that follows take the whole queue at once.
        if (opts?.flush) {
          session.flushQueue = true
        }
        emitQueue(sessionId, session.queue)
        return
      }
      // Idle, so this delivers now. A flush still has to carry anything left
      // holding — a queue can outlive its turn when that turn failed before
      // settling — otherwise those messages would wait for a turn that is
      // never coming.
      if (opts?.flush && session.queue.length > 0) {
        const texts = [...session.queue.map((item) => item.text), text]
        session.queue = []
        emitQueue(sessionId, session.queue)
        await deliverPrompt(sessionId, joinPrompts(texts))
        return
      }
      await deliverPrompt(sessionId, text)
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

    resolveElicitation(requestId: string, answer?: string): void {
      const pending = store.pendingElicitations.get(requestId)
      if (!pending) {
        return
      }
      store.pendingElicitations.delete(requestId)
      pending.resolve(answer ? { action: 'accept', content: { answer } } : { action: 'cancel' })
      emit(pending.sessionId, { kind: 'ask_user_resolved', requestId })
    },

    async cancel(sessionId: string): Promise<void> {
      if (!store.sessions.has(sessionId)) {
        return
      }
      const connection = await connectionForSession(sessionId)
      await connection.cancel({ sessionId })
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
