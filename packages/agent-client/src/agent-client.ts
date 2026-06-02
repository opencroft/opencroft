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
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

import { readMcpConfig, resolveMcpServers } from './mcp-config'
import { createMcpServer, type LocalTool, type SkillHandler, type SkillsInput } from './mcp-server'
import type { McpServerConfig } from './mcp-types'
import { buildSpawnConfig } from './resolve'
import { fileSkillHandler, fileSkills } from './skills'
import type { AgentSelection, ChatEvent, SessionMeta, SessionMode, SpawnConfig } from './types'

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
}

type Subscriber = (event: ChatEvent) => void

interface SessionState {
  meta: SessionMeta
  // The resolved selection is kept in memory so the engine can reconnect /
  // resume without any on-disk profile store.
  selection: AgentSelection
  events: ChatEvent[]
  subscribers: Set<Subscriber>
}

interface ConnEntry {
  process: ChildProcessWithoutNullStreams
  connection: ClientSideConnection
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
  lastModes: { available: SessionMode[]; current: string } | null
}

function createStore(): ClientStore {
  return {
    connections: new Map(),
    sessions: new Map(),
    lastSessionId: null,
    pendingPermissions: new Map(),
    pendingElicitations: new Map(),
    lastModes: null,
  }
}

const globalRef = globalThis as typeof globalThis & {
  __acpStore?: ClientStore
}
if (!globalRef.__acpStore) {
  globalRef.__acpStore = createStore()
}
const store = globalRef.__acpStore

function textOf(content: ContentBlock): string {
  if (content.type === 'text') {
    return content.text
  }
  return `[${content.type}]`
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
        output: update.rawOutput ?? undefined,
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
      emit(sessionId, { kind: 'mode_changed', current: update.currentModeId })
      break
    }
    default:
      break
  }
}

function buildClient(): Client {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      handleUpdate(notification)
    },
    requestPermission: (request: RequestPermissionRequest) =>
      new Promise<RequestPermissionResponse>((resolve) => {
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
        const sessionId = store.lastSessionId
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

function applyModes(modes: { availableModes: { id: string; name: string; description?: string | null }[]; currentModeId: string }): void {
  const available = modes.availableModes.map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description ?? undefined,
  }))
  store.lastModes = { available, current: modes.currentModeId }
}

function spawnKey(config: SpawnConfig): string {
  return JSON.stringify(config)
}

async function ensureConnection(selection: AgentSelection): Promise<ClientSideConnection> {
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
  })
  child.stderr.on('data', (chunk: Buffer) => {
    console.error('[acp-agent]', chunk.toString())
  })
  child.on('exit', () => {
    store.connections.delete(key)
  })
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
  const connection = new ClientSideConnection(() => buildClient(), stream)
  store.connections.set(key, { process: child, connection })
  await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      elicitation: {},
    },
    clientInfo: { name: 'demo-chat-app', version: '0.1.0' },
  })
  return connection
}

// Resolve a live connection for an already-created session, using the spawn
// config of the session's recorded profile (falling back to the active one).
async function connectionForSession(sessionId: string): Promise<ClientSideConnection> {
  const selection = store.sessions.get(sessionId)?.selection
  if (!selection) {
    throw new Error(`Unknown session: ${sessionId}`)
  }
  return ensureConnection(selection)
}

export function createAgentClient(options: AgentClientOptions = {}) {
  const mcpServerName = options.mcpServerName ?? 'local'
  const mcp = createMcpServer({
    name: mcpServerName,
    tools: options.tools ?? [],
    skills: options.skills ?? [],
    skillHandler: options.skillHandler,
  })

  async function buildMcpServers(): Promise<AcpMcpServer[]> {
    const url = await mcp.ensureUrl()
    const internal: AcpMcpServer = {
      type: 'http',
      name: mcpServerName,
      url,
      headers: [],
    }
    const configured = options.loadMcpServers ? await options.loadMcpServers() : await readMcpConfig()
    return [internal, ...(options.extraMcpServers ?? []), ...resolveMcpServers(configured)]
  }

  return {
    listSessions(): SessionMeta[] {
      return [...store.sessions.values()].map((session) => session.meta).sort((a, b) => a.createdAt - b.createdAt)
    },

    async createSession(selection: AgentSelection, defaultModeId?: string): Promise<SessionMeta> {
      const connection = await ensureConnection(selection)
      const response = await connection.newSession({
        cwd: selection.cwd,
        mcpServers: await buildMcpServers(),
      })
      const sessionId = response.sessionId
      const meta: SessionMeta = {
        id: sessionId,
        title: `New chat ${store.sessions.size + 1}`,
        createdAt: Date.now(),
      }
      store.sessions.set(sessionId, {
        meta,
        selection,
        events: [],
        subscribers: new Set(),
      })
      if (response.modes) {
        applyModes(response.modes)
        emit(sessionId, {
          kind: 'modes',
          available: store.lastModes?.available ?? [],
          current: response.modes.currentModeId,
        })
      }
      // Apply the requested initial approval mode, when offered.
      if (defaultModeId && response.modes && response.modes.currentModeId !== defaultModeId && response.modes.availableModes.some((mode) => mode.id === defaultModeId)) {
        await connection
          .setSessionMode({ sessionId, modeId: defaultModeId })
          .then(() =>
            emit(sessionId, {
              kind: 'mode_changed',
              current: defaultModeId,
            }),
          )
          .catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
      }
      return meta
    },

    async resumeSession(sessionId: string): Promise<void> {
      const session = store.sessions.get(sessionId)
      if (!session) {
        return
      }
      const connection = await ensureConnection(session.selection)
      await connection.resumeSession({
        sessionId,
        cwd: session.selection.cwd,
        mcpServers: await buildMcpServers(),
      })
    },

    async refreshMcpServers(): Promise<void> {
      for (const sessionId of store.sessions.keys()) {
        await this.resumeSession(sessionId).catch((error: unknown) => emit(sessionId, { kind: 'error', message: errorMessage(error) }))
      }
    },

    async setMode(sessionId: string, modeId: string): Promise<void> {
      const connection = await connectionForSession(sessionId)
      await connection.setSessionMode({ sessionId, modeId })
      emit(sessionId, { kind: 'mode_changed', current: modeId })
    },

    deleteSession(sessionId: string): void {
      store.sessions.delete(sessionId)
      if (store.lastSessionId === sessionId) {
        store.lastSessionId = null
      }
    },

    async prompt(sessionId: string, text: string): Promise<void> {
      if (!store.sessions.has(sessionId)) {
        return
      }
      const connection = await connectionForSession(sessionId)
      store.lastSessionId = sessionId
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
      if (store.lastModes && !session.events.some((event) => event.kind === 'modes')) {
        session.events.unshift({
          kind: 'modes',
          available: store.lastModes.available,
          current: store.lastModes.current,
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
        entry.process.kill()
      }
      store.connections.clear()
      store.sessions.clear()
      store.pendingPermissions.clear()
      store.pendingElicitations.clear()
      store.lastSessionId = null
      store.lastModes = null
    },
  }
}

export const agentClient = createAgentClient({
  skills: fileSkills,
  skillHandler: fileSkillHandler,
})
