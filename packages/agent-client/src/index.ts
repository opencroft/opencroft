// Server entry: API routes import the engine from here.

export type { AgentClientOptions, ClientInfo } from './agent-client'
export { agentClient, createAgentClient, supportsMidTurnInput } from './agent-client'
export type { ChatBlock, ChatMessage } from './fold'
export { buildBlocks, foldEvents, isTerminalToolStatus } from './fold'
// Tool / skill registration surface.
export type { LocalTool, SkillHandler, SkillsInput, ToolsCaller, ToolsInput } from './mcp-server'
export type { KeyValue, McpServerConfig, McpTransport } from './mcp-types'
export type { EventsWindow } from './pagination'
// Permission model (also importable via the subpath).
export type { AgentRole, DefaultAccess, PermissionValue, ResolvedPermissions } from './permissions'
export { accessFor, resolveSessionPermissions, skillKey, toolKey } from './permissions'
// Canonical reasoning-effort vocabulary (also importable via the subpath).
export type { CanonicalEffortId, CanonicalEffortInfo } from './session-effort'
export { CANONICAL_EFFORTS, canonicalEffortId } from './session-effort'
// Canonical permission-mode vocabulary (also importable via the subpath).
export type { CanonicalModeId, CanonicalModeInfo, ClassifiedMode } from './session-modes'
export { CANONICAL_MODES, canonicalModeId, classifyModes, modeIdForCanonical } from './session-modes'
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
