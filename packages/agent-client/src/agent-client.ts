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
  SessionNotification,
  ToolCallContent,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

import type { AgentConnection } from './connection'
import { readMcpConfig, resolveMcpServers } from './mcp-config'
import { createMcpServer, type LocalTool, type SkillHandler, type SkillsInput } from './mcp-server'
import type { McpServerConfig } from './mcp-types'
import { createNativeHarness, type NativeHarnessConfig, type NativeSession } from './native-harness'
import { type ResolvedPermissions, toolKey } from './permissions'
import { buildSpawnConfig, findAdapter } from './resolve'
import { fileSkillHandler, fileSkills } from './skills'
import { findTurnBoundary } from './turns'
import type { AgentSelection, ChatEvent, SessionMeta, SessionMode, SpawnConfig } from './types'

export interface ClientInfo {
  name: string
  version: string
}

export interface AgentClientOptions {
  mcpServerName?: string
  tools?: LocalTool[]
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
  // Effective per-tool / per-skill permissions; undefined = unrestricted.
  permissions?: ResolvedPermissions
}

interface ConnEntry {
  // Absent for the in-process native harness, which has no subprocess.
  process?: ChildProcessWithoutNullStreams
  connection: AgentConnection
  // The session last prompted through this connection — scopes elicitation
  // routing per connection instead of globally.
  lastSessionId: string | null
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
// in `content` for clients that render markdown; opencroft shows tool output
// verbatim, so an unstripped fence would render as literal backticks.
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function emit(sessionId: string, event: ChatEvent): void {
  const session = store.sessions.get(sessionId)
  if (!session) {
    return
  }
  session.events.push(event)
  for (const subscriber of session.subscribers) {
    subscriber(event)
  }
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

function handleUpdate(notification: SessionNotification): void {
  const { sessionId, update } = notification
  switch (update.sessionUpdate) {
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
      emit(sessionId, {
        kind: 'usage',
        used: update.used,
        size: update.size > 0 ? update.size : undefined,
      })
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

// Pick the option that grants the call (kind starts with "allow"), falling back
// to a conventional id when the agent labels them differently.
function pickAllowOption(request: RequestPermissionRequest): string {
  return request.options.find((option) => option.kind.startsWith('allow'))?.optionId ?? 'allow'
}

// Resolve the session an elicitation belongs to, scoped to the connection it
// arrived on, with the global last-prompted session as a fallback.
function buildClient(getElicitationSession: () => string | null): Client {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      handleUpdate(notification)
    },
    requestPermission: (request: RequestPermissionRequest) =>
      new Promise<RequestPermissionResponse>((resolve) => {
        const perms = store.sessions.get(request.sessionId)?.permissions
        if (isAlwaysAllowed(perms, request.toolCall.title ?? '')) {
          resolve({ outcome: { outcome: 'selected', optionId: pickAllowOption(request) } })
          return
        }
        const requestId = randomUUID()
        store.pendingPermissions.set(requestId, {
          sessionId: request.sessionId,
          resolve,
        })
        emit(request.sessionId, {
          kind: 'permission_request',
          requestId,
          title: request.toolCall.title ?? 'tool call',
          options: request.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            kind: option.kind,
          })),
        })
      }),
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
        return store.sessions.get(sessionId)?.permissions
      }
      return store.acpTokenPermissions.get(token)
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
  async function buildMcpServers(): Promise<{ internal: AcpMcpServer; servers: AcpMcpServer[] }> {
    const url = await mcp.ensureUrl()
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
      buildClient(() => store.lastSessionId),
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
      return existing.connection
    }
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: spawnConfig.cwd,
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
    const connection = new ClientSideConnection(() => buildClient(() => entry.lastSessionId), stream)
    entry = { process: child, connection, lastSessionId: null }
    store.connections.set(key, entry)
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        elicitation: {},
      },
      clientInfo,
    })
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

  return {
    listSessions(): SessionMeta[] {
      return [...store.sessions.values()].map((session) => session.meta).sort((a, b) => a.createdAt - b.createdAt)
    },

    // The host's statically registered LocalTools (for role-permission editors).
    // Per-session MCP and skill tools are dynamic and not listed here.
    listTools(): { name: string; description: string }[] {
      return (options.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }))
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
      if (!native) {
        const { internal, servers } = await buildMcpServers()
        token = randomUUID()
        store.acpTokenPermissions.set(token, permissions)
        mcpServers = tagInternal(internal, servers, token)
      }
      const response = await connection.newSession({
        cwd: selection.cwd,
        mcpServers,
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
      const meta: SessionMeta = {
        id: sessionId,
        title: `New chat ${store.titleCounter}`,
        createdAt: Date.now(),
        canFork: native,
      }
      store.sessions.set(sessionId, {
        meta,
        selection,
        events: [],
        subscribers: new Set(),
        modes: response.modes ? toSessionModes(response.modes) : null,
        permissions,
      })
      if (response.modes) {
        emitSessionModes(sessionId)
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
      if (!native && selection.reasoningEffort && response.configOptions) {
        const option = response.configOptions.find(
          (entry) => entry.category === 'thought_level' && entry.type === 'select',
        )
        const value =
          option && option.type === 'select'
            ? matchReasoningValue(option.options, selection.reasoningEffort)
            : undefined
        if (option && value) {
          await connection
            .setSessionConfigOption({ sessionId, configId: option.id, value })
            .catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
        }
      }
      return meta
    },

    async resumeSession(sessionId: string): Promise<void> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return
      }
      const connection = await ensureConnection(session.selection)
      let mcpServers: AcpMcpServer[] = []
      if (!isNativeSelection(session.selection)) {
        // Retire the prior token for this session before minting a new one so
        // repeated resumes (e.g. on every MCP-config refresh) don't leak tokens.
        // permissionsFor resolves via the session record, which is already set.
        dropSessionTokens(sessionId)
        const { internal, servers } = await buildMcpServers()
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

    deleteSession(sessionId: string): void {
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
      const forkedEvents =
        boundary === null ? session.events.filter((event) => event.kind === 'modes') : session.events.slice(0, boundary)
      const meta: SessionMeta = {
        id: response.sessionId,
        title: `${session.meta.title} (fork)`,
        createdAt: Date.now(),
        profileId: session.meta.profileId,
        canFork: true,
      }
      store.sessions.set(response.sessionId, {
        meta,
        selection: session.selection,
        events: forkedEvents,
        subscribers: new Set(),
        modes: response.modes ? toSessionModes(response.modes) : session.modes,
        permissions: session.permissions,
      })
      return meta
    },

    async prompt(sessionId: string, text: string): Promise<void> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return
      }
      const connection = await connectionForSession(sessionId)
      store.lastSessionId = sessionId
      const entry = connEntryFor(session.selection)
      if (entry) {
        entry.lastSessionId = sessionId
      }
      emit(sessionId, { kind: 'user', text })
      void connection
        .prompt({ sessionId, prompt: [{ type: 'text', text }] })
        .then((response) =>
          emit(sessionId, {
            kind: 'turn_end',
            stopReason: response.stopReason,
          }),
        )
        .catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
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

    subscribe(sessionId: string, subscriber: Subscriber): () => void {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return () => {}
      }
      if (session.modes && !session.events.some((event) => event.kind === 'modes')) {
        session.events.unshift({
          kind: 'modes',
          available: session.modes.available,
          current: session.modes.current,
        })
      }
      for (const event of session.events) {
        subscriber(event)
      }
      session.subscribers.add(subscriber)
      return () => {
        session.subscribers.delete(subscriber)
      }
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
