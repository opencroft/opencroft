import { readMcpConfig, writeMcpConfig } from 'agent-client/mcp-config'
import type { McpServerConfig } from 'agent-client/mcp-types'

import type { McpStore } from './runtime'

// Default MCP store: the mcp-config.json file in the server's working directory
// (alongside agent-profiles.json). A host can inject a DB-backed store instead
// via configureAgentChat({ mcp }).
export const fileMcpStore: McpStore = {
  read: (): Promise<McpServerConfig[]> => readMcpConfig(),
  write: (servers: McpServerConfig[]): Promise<void> => writeMcpConfig(servers),
}
