// Server entry: API routes import the engine from here.

export type { AgentClientOptions } from './agent-client'
export { agentClient, createAgentClient } from './agent-client'
export type { ChatBlock, ChatMessage } from './fold'
export { buildBlocks, foldEvents } from './fold'
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
