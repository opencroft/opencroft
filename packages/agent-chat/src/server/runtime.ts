// Server-side dependency injection for the agent-chat server functions.
//
// The chat UI ships its own TanStack server functions (see ./actions), but the
// agent *engine* and the skills data layer are host-specific: the engine is
// built with the host's local tools, and skills may be backed by a database.
// So the host registers them once at server startup via `configureAgentChat`,
// and the server functions read them back through `getRuntime`.
//
// The registry lives on `globalThis` so it survives dev hot-reloads (the same
// reason agent-client keeps its session store there).

import type { createAgentClient } from 'agent-client'
import type { McpServerConfig } from 'agent-client/mcp-types'
import type { DefaultAccess, PermissionValue } from 'agent-client/permissions'
import type { ProfilesFile } from 'agent-client/profiles'

import { fileMcpStore } from './mcp-store'
import { fileProfilesStore } from './profiles-store'

// The agent engine — the object returned by agent-client's `createAgentClient`.
export type AgentEngine = ReturnType<typeof createAgentClient>

// A single editable skill (the agent's reusable, load-on-demand instructions).
// Structurally matches the host's storage row (extra columns are allowed).
export interface SkillRecord {
  id: string
  name: string
  description: string
  content: string
}

// CRUD over the host's skill storage (a DB table, a folder of files, …).
export interface SkillsDataLayer {
  list(): SkillRecord[] | Promise<SkillRecord[]>
  getByName(name: string): SkillRecord | null | Promise<SkillRecord | null>
  create(input: { name: string; description?: string; content?: string }): SkillRecord | Promise<SkillRecord>
  update(
    name: string,
    updates: { name?: string; description?: string; content?: string },
  ): SkillRecord | null | Promise<SkillRecord | null>
  remove(name: string): void | Promise<void>
}

// Where agent profiles are persisted. Defaults to a JSON file (see
// ./profiles-store); a host can swap in a DB-backed store instead.
export interface ProfilesStore {
  read(): Promise<ProfilesFile>
  write(data: ProfilesFile): Promise<void>
}

// Where the user-configured MCP servers are persisted. Defaults to the
// mcp-config.json file (see ./mcp-store); a host can swap in a DB-backed store.
// The same store should back the engine's `loadMcpServers` so sessions and the
// editor UI agree on the server set.
export interface McpStore {
  read(): McpServerConfig[] | Promise<McpServerConfig[]>
  write(servers: McpServerConfig[]): void | Promise<void>
}

// A single agent role (per-tool / per-skill permissions). Structurally matches
// the host's storage row (extra columns are allowed).
export interface RoleRecord {
  id: string
  name: string
  description: string
  permissions: Record<string, PermissionValue>
}

// CRUD over the host's role storage, plus the global default-access setting
// (applied when a session has no roles in effect). Optional on the runtime: when
// absent, sessions run unrestricted with default access "Allow" (today's behavior).
export interface RolesDataLayer {
  list(): RoleRecord[] | Promise<RoleRecord[]>
  getById(id: string): RoleRecord | null | Promise<RoleRecord | null>
  create(input: {
    name: string
    description?: string
    permissions?: Record<string, PermissionValue>
  }): RoleRecord | Promise<RoleRecord>
  update(
    id: string,
    updates: {
      name?: string
      description?: string
      permissions?: Record<string, PermissionValue>
    },
  ): RoleRecord | null | Promise<RoleRecord | null>
  remove(id: string): void | Promise<void>
  getDefaultAccess(): DefaultAccess | Promise<DefaultAccess>
  setDefaultAccess(access: DefaultAccess): void | Promise<void>
}

export interface AgentChatRuntime {
  agent: AgentEngine
  skills: SkillsDataLayer
  // Optional — defaults to the JSON-file profiles store.
  profiles?: ProfilesStore
  // Optional — defaults to the mcp-config.json file store.
  mcp?: McpStore
  // Optional — when absent, sessions are unrestricted (no roles).
  roles?: RolesDataLayer
}

interface ResolvedRuntime extends AgentChatRuntime {
  profiles: ProfilesStore
  mcp: McpStore
}

const globalRef = globalThis as typeof globalThis & {
  __agentChatRuntime?: ResolvedRuntime
}

// Register the host's engine + data layers. Call once on the server (e.g. from
// the app's instrumentation `register()` hook) before any chat request runs.
export function configureAgentChat(runtime: AgentChatRuntime): void {
  // Fall back to the file-based stores so hosts that don't keep these elsewhere
  // need no extra wiring.
  globalRef.__agentChatRuntime = {
    ...runtime,
    profiles: runtime.profiles ?? fileProfilesStore,
    mcp: runtime.mcp ?? fileMcpStore,
  }
}

export function getRuntime(): ResolvedRuntime {
  const runtime = globalRef.__agentChatRuntime
  if (!runtime) {
    throw new Error(
      'agent-chat: runtime not configured. Call configureAgentChat({ agent, skills }) ' +
        'on the server (e.g. from your app instrumentation register() hook) before using ' +
        'the chat server functions.',
    )
  }
  return runtime
}
