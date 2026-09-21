// Client entry for agent-chat: chat + configuration UI. Server wiring (runtime
// registration, server functions, SSE handler) is exported from `agent-chat/server`.

export { ConfigOptionsBar, type ConfigOptionsBarProps } from './config-options-bar'
export { markdownLinkComponents } from './markdown-link'
export {
  McpServerDialog,
  type McpServerDialogProps,
  McpServerForm,
  type McpServerFormProps,
} from './mcp-form'
export {
  AppearGuard,
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
export { type SkillRecord, SkillsManager, type SkillsManagerProps } from './skills-manager'
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
export {
  type AgentSessionController,
  type AgentUsage,
  type UseAgentSessionOptions,
  useAgentSession,
} from './use-agent-session'
export { type UsePaginatedHistoryOptions, usePaginatedHistory } from './use-paginated-history'
