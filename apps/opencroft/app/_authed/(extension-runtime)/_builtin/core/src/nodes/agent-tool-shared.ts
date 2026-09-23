import type { ExecutionMode } from '@opencroft/client'

// What an agent-tool node stores: written by its inspector, read by the host's
// tool registry when it lists and dispatches the tool (tools.ts in (mcp)).
export interface AgentToolData {
  name: string
  description: string
  inputSchema: string // JSON Schema as string
  requireApproval: boolean
  /** How a caller waits for the tool. Absent: sync, as every node drawn before this existed. */
  execution?: ExecutionMode
}
