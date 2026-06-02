import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type ZodRawShape, z } from 'zod'

import type { SkillDef } from './skills'

export interface LocalTool {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<string> | string
}

export type SkillsInput = SkillDef[] | (() => Promise<SkillDef[]>)

export type SkillHandler = (name: string) => Promise<string>

export interface McpServerOptions {
  name: string
  tools: LocalTool[]
  skills: SkillsInput
  skillHandler?: SkillHandler
}

export interface McpServerHandle {
  ensureUrl: () => Promise<string>
}

interface RunningServer {
  http: Server
  url: string
}

const globalRef = globalThis as typeof globalThis & {
  __acpMcpServers?: Map<string, RunningServer>
}
if (!globalRef.__acpMcpServers) {
  globalRef.__acpMcpServers = new Map()
}
const servers = globalRef.__acpMcpServers

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

async function resolveSkills(skills: SkillsInput): Promise<SkillDef[]> {
  return typeof skills === 'function' ? skills() : skills
}

async function buildServer(options: McpServerOptions): Promise<McpServer> {
  const server = new McpServer({
    name: `demo-chat-app-${options.name}`,
    version: '0.1.0',
  })
  const skills = await resolveSkills(options.skills)
  const skillHandler = options.skillHandler
  if (skills.length > 0 && skillHandler) {
    const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
    server.registerTool(
      'skill',
      {
        description: `The following skills are available for use with this mcp tool:\n${catalog}`,
        inputSchema: {
          skill: z.string().describe('Name of the skill to load'),
        },
      },
      async ({ skill }) => textResult(await skillHandler(skill)),
    )
  }
  for (const tool of options.tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => textResult(await tool.handler(args)))
  }
  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) {
    return undefined
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function handle(options: McpServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => void transport.close())
  const server = await buildServer(options)
  await server.connect(transport)
  await transport.handleRequest(req, res, await readBody(req))
}

export function createMcpServer(options: McpServerOptions): McpServerHandle {
  return {
    async ensureUrl(): Promise<string> {
      const existing = servers.get(options.name)
      if (existing) {
        return existing.url
      }
      const http = createServer((req, res) => {
        void handle(options, req, res).catch(() => {
          res.statusCode = 500
          res.end()
        })
      })
      await new Promise<void>((resolve) => {
        http.listen(0, '127.0.0.1', resolve)
      })
      const address = http.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const url = `http://127.0.0.1:${port}/mcp`
      servers.set(options.name, { http, url })
      return url
    },
  }
}
