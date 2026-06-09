// Client entry for agent-chat: chat + configuration UI. Server wiring (runtime
// registration, server functions, SSE handler) is exported from `agent-chat/server`.

export { AgentChat, type AgentChatProps } from './agent-chat'
export { ChatView, type ChatViewProps } from './chat-view'
export { AgentChatInput, type AgentChatInputProps } from './chat-input'
export {
  AgentPresetForm,
  AgentProfilePicker,
  EMPTY_SELECTION,
  canStartSelection,
  type AgentPresetFormProps,
  type AgentProfilePickerProps,
} from './preset-form'
export {
  McpServerForm,
  McpServerDialog,
  type McpServerFormProps,
  type McpServerDialogProps,
} from './mcp-form'
export { SkillEditor, type SkillEditorProps } from './skill-editor'
export { SkillsManager, type SkillsManagerProps, type SkillRecord } from './skills-manager'
export {
  MessageView,
  ToolView,
  ToolCallCard,
  PermissionRequest,
  PlanView,
  AskPrompt,
  statusVariant,
  type MessageHandlers,
} from './messages'
export {
  imageToolView,
  extractUrl,
  hasToolView,
  type ToolViewDef,
  type ToolViewDisplay,
  type ToolViewRegistry,
  type ToolMessage,
} from './tool-views'
export {
  ToolCallBlock,
  previewArg,
  type ToolCallBlockProps,
  type ToolCallResult,
} from './tool-block'
export { ThinkingBlock, type ThinkingBlockProps } from './thinking-block'
export {
  Chained,
  ChainDot,
  type ChainDotVariant,
  type ChainedAlign,
  type ChainedProps,
} from './chain'
export { AskUser, type AskUserProps, type AskUserQuestion } from './ask-user'
export {
  useAgentSession,
  type UseAgentSessionOptions,
  type AgentSessionController,
  type AgentUsage,
} from './use-agent-session'
