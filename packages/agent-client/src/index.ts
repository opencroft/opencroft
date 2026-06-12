// Server entry: API routes import the engine from here.

export type { AgentClientOptions, ClientInfo } from './agent-client'
export { agentClient, createAgentClient } from './agent-client'
export type { ChatBlock, ChatMessage } from './fold'
export { buildBlocks, foldEvents } from './fold'
// Tool / skill registration surface.
export type { LocalTool, SkillHandler, SkillsInput } from './mcp-server'
export type { KeyValue, McpServerConfig, McpTransport } from './mcp-types'
// Permission model (also importable via the subpath).
export type { AgentRole, DefaultAccess, PermissionValue, ResolvedPermissions } from './permissions'
export { accessFor, resolveSessionPermissions, skillKey, toolKey } from './permissions'
export type { SkillDef } from './skills'
// Shared client-safe types & helpers (also importable via subpaths).
export type {
  AgentSelection,
  ChatEvent,
  PermissionOpt,
  PlanItem,
  SessionMeta,
  SessionMode,
  SpawnConfig,
} from './types'
