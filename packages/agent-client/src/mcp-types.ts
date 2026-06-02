// Node-free MCP config types — safe to import from browser/client code.
// (mcp-config.ts re-exports these but also pulls in node:fs, so client code
// must import the types from here.)

export type McpTransport = 'http' | 'sse' | 'stdio'

export interface KeyValue {
  name: string
  value: string
}

export interface McpServerConfig {
  name: string
  transport: McpTransport
  url?: string
  command?: string
  args?: string[]
  headers?: KeyValue[]
  env?: KeyValue[]
}
