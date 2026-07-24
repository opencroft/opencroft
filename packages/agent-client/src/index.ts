// Server entry: API routes import the engine from here.

export type { AgentClientOptions, ClientInfo } from './agent-client'
export { agentClient, createAgentClient, supportsMidTurnInput } from './agent-client'
export type { ChatBlock, ChatMessage } from './fold'
export { buildBlocks, foldEvents } from './fold'
// Tool / skill registration surface.
export type { LocalTool, SkillHandler, SkillsInput, ToolsInput } from './mcp-server'
export type { KeyValue, McpServerConfig, McpTransport } from './mcp-types'
export type { EventsWindow } from './pagination'
// Permission model (also importable via the subpath).
export type { AgentRole, DefaultAccess, PermissionValue, ResolvedPermissions } from './permissions'
export { accessFor, resolveSessionPermissions, skillKey, toolKey } from './permissions'
export type { SkillDef } from './skills'
export type { ToolResult } from './tool-result'
// Shared client-safe types & helpers (also importable via subpaths).
export type {
  AgentSelection,
  ChatEvent,
  PermissionOpt,
  PlanItem,
  QueuedPrompt,
  SessionMeta,
  SessionMode,
  SpawnConfig,
} from './types'
