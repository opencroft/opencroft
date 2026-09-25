// Server entry: API routes import the engine from here.

export type { AgentClientOptions, ClientInfo, PromptAttachmentInput } from './agent-client'
export { agentClient, createAgentClient, supportsImagePrompt, supportsMidTurnInput } from './agent-client'
// What a message carries beside its words. The host hands attachments to
// prompt() and resolves their bytes through loadAttachments; the engine turns
// them into ACP image blocks at delivery.
export type { AttachmentRef, DeliveredAttachment, PromptAttachment } from './attachments'
export { isImageMime } from './attachments'
// Independent chat completions -- one request/response against a profile's
// endpoint, with no session and no tools (also importable via the subpath).
export type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatCompletionStream,
  ChatCompletionUsage,
  ChatMessageRecord,
} from './chat-completion'
export { completeChat, streamChat, toChatMessages } from './chat-completion'
// Which config option carries which meaning -- category first, then id (also
// importable via the subpath).
export type { ConfigSelector } from './config-selectors'
export {
  FAST_MODE_SELECTOR,
  findConfigOption,
  findSelectOption,
  MODE_SELECTOR,
  MODEL_SELECTOR,
  THOUGHT_LEVEL_SELECTOR,
} from './config-selectors'
export { resolveSelectionContextWindow, selectionModels } from './endpoint'
export type { ChatBlock, ChatMessage } from './fold'
export { buildBlocks, foldEvents, isTerminalToolStatus } from './fold'
// Tool / skill registration surface.
export type { LocalTool, SkillHandler, SkillsInput, ToolsCaller, ToolsInput } from './mcp-server'
export type { KeyValue, McpServerConfig, McpTransport } from './mcp-types'
export type { EventsWindow } from './pagination'
// Permission model (also importable via the subpath).
export type { AgentRole, DefaultAccess, PermissionValue, ResolvedPermissions } from './permissions'
export { accessFor, resolveSessionPermissions, skillKey, toolKey } from './permissions'
// Which reasoning-effort levels a model name suggests, and the weakest of them
// — client-safe heuristics, keyed off model-name families.
export { leastEffort, reasoningEfforts } from './reasoning'
// Canonical reasoning-effort vocabulary (also importable via the subpath).
export type { CanonicalEffortId, CanonicalEffortInfo } from './session-effort'
export { CANONICAL_EFFORTS, canonicalEffortId } from './session-effort'
// Canonical permission-mode vocabulary (also importable via the subpath).
export type { CanonicalModeId, CanonicalModeInfo, ClassifiedMode } from './session-modes'
export {
  CANONICAL_MODES,
  canonicalModeId,
  canonicalModeOf,
  classifyModes,
  modeIdForCanonical,
  mostSupervisedModeId,
  SUPERVISION_ORDER,
} from './session-modes'
export type { SkillDef } from './skills'
// The synonym registry both vocabularies are built on.
export type { SynonymRegistration, SynonymResolver } from './synonyms'
export { createSynonymResolver } from './synonyms'
export type { ToolResult } from './tool-result'
// Shared client-safe types & helpers (also importable via subpaths).
export type {
  AgentSelection,
  ChatEvent,
  PermissionOpt,
  PlanItem,
  QueuedPrompt,
  QueueMode,
  SessionMeta,
  SessionMode,
  SpawnConfig,
} from './types'
