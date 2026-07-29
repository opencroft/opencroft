// Client entry for agent-chat: chat + configuration UI. Server wiring (runtime
// registration, server functions, SSE handler) is exported from `agent-chat/server`.

export { AgentChat, type AgentChatProps } from './agent-chat'
export { AskUser, type AskUserProps, type AskUserQuestion } from './ask-user'
export {
  ChainDot,
  type ChainDotVariant,
  Chained,
  type ChainedAlign,
  type ChainedProps,
} from './chain'
export { AgentChatInput, type AgentChatInputProps } from './chat-input'
export { ChatView, type ChatViewProps } from './chat-view'
export { ConfigOptionsBar, type ConfigOptionsBarProps } from './config-options-bar'
export { markdownLinkComponents } from './markdown-link'
export {
  McpServerDialog,
  type McpServerDialogProps,
  McpServerForm,
  type McpServerFormProps,
} from './mcp-form'
export {
  AskPrompt,
  type MessageHandlers,
  MessageView,
  PermissionRequest,
  PlanView,
  statusVariant,
  ToolView,
} from './messages'
export {
  AgentPresetForm,
  type AgentPresetFormProps,
  AgentProfilePicker,
  type AgentProfilePickerProps,
  canStartSelection,
  EMPTY_SELECTION,
} from './preset-form'
export { QueuedMessages, type QueuedMessagesProps } from './queued-messages'
export { SkillEditor, type SkillEditorProps } from './skill-editor'
export { type SkillRecord, SkillsManager, type SkillsManagerProps } from './skills-manager'
export { ThinkingBlock, type ThinkingBlockProps } from './thinking-block'
export { ThinkingIndicator } from './thinking-indicator'
export { previewArg, ToolCallBlock, type ToolCallBlockProps, type ToolCallResult } from './tool-block'
export {
  extractUrl,
  formatToolValue,
  hasToolView,
  imageToolView,
  lookupToolView,
  normalizeToolId,
  type ToolMessage,
  type ToolViewDisplay,
  type ToolViewMode,
  type ToolViewProps,
  type ToolViewRegistry,
  type ToolViewResult,
  type ToolViewSpec,
  toolViewProps,
} from './tool-views'
export { TurnDetails, type TurnDetailsProps } from './turn-details'
export { groupIntoTurnSections, type TurnSection } from './turn-sections'
export {
  type AgentSessionController,
  type AgentUsage,
  type UseAgentSessionOptions,
  useAgentSession,
} from './use-agent-session'
export { type UsePaginatedHistoryOptions, usePaginatedHistory } from './use-paginated-history'
