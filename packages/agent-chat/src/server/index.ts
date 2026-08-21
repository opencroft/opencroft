// Server entry for the agent-chat package: the host registers its runtime here,
// re-exports the chat server functions, and wires the SSE route.

export * from './actions'
export { agentEventsResponse } from './events'
export { fileMcpStore } from './mcp-store'
export { fileProfilesStore } from './profiles-store'
export {
  type AgentChatRuntime,
  type AgentEngine,
  configureAgentChat,
  getRuntime,
  type McpStore,
  type ProfilesStore,
  READER_FALLBACK,
  type ReaderIdentity,
  type RoleRecord,
  type RolesDataLayer,
  resolveReaderName,
  type SkillRecord,
  type SkillsDataLayer,
} from './runtime'
