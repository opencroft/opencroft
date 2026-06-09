// Server entry for the agent-chat package: the host registers its runtime here,
// re-exports the chat server functions, and wires the SSE route.

export {
  configureAgentChat,
  getRuntime,
  type AgentChatRuntime,
  type AgentEngine,
  type ProfilesStore,
  type RoleRecord,
  type RolesDataLayer,
  type SkillRecord,
  type SkillsDataLayer,
} from './runtime'
export { fileProfilesStore } from './profiles-store'
export { agentEventsResponse } from './events'
export * from './actions'
