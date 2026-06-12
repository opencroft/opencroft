import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'

import type { McpServerConfig } from './mcp-types'

const CONFIG_PATH = join(process.cwd(), 'mcp-config.json')

export async function readMcpConfig(): Promise<McpServerConfig[]> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(raw) as McpServerConfig[]
  } catch {
    return []
  }
}

export async function writeMcpConfig(servers: McpServerConfig[]): Promise<void> {
  await writeFile(CONFIG_PATH, `${JSON.stringify(servers, null, 2)}\n`, 'utf8')
}

export function toAcpMcpServer(config: McpServerConfig): AcpMcpServer | null {
  if (config.transport === 'stdio') {
    if (!config.command) {
      return null
    }
    return {
      name: config.name,
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? [],
    }
  }
  if (!config.url) {
    return null
  }
  return {
    type: config.transport,
    name: config.name,
    url: config.url,
    headers: config.headers ?? [],
  }
}

export function resolveMcpServers(configs: McpServerConfig[]): AcpMcpServer[] {
  return configs.map(toAcpMcpServer).filter((server): server is AcpMcpServer => server !== null)
}
