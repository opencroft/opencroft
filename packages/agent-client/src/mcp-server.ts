import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type ZodRawShape, z } from 'zod'

import { accessFor, type ResolvedPermissions, skillKey, toolKey } from './permissions'
import type { SkillDef } from './skills'
import { type ToolResult, toCallToolResult } from './tool-result'

export interface LocalTool {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult
}

export type SkillsInput = SkillDef[] | (() => Promise<SkillDef[]>)

// Mirrors SkillsInput: a static array, or a function re-evaluated per request
// so a live source (e.g. dynamic agent-tool graph nodes) stays current without
// a restart.
export type ToolsInput = LocalTool[] | (() => Promise<LocalTool[]>)

export type SkillHandler = (name: string) => Promise<string>

export interface McpServerOptions {
  name: string
  tools: ToolsInput
  skills: SkillsInput
  skillHandler?: SkillHandler
  // Resolve per-session permissions for an incoming request token (the
  // 'x-agent-session' header). Absent/undefined => serve everything.
  permissionsFor?: (sessionToken: string) => ResolvedPermissions | undefined
}

export interface McpServerHandle {
  ensureUrl: () => Promise<string>
  close: () => Promise<void>
}

interface RunningServer {
  http: Server
  url: string
  // The live options the handler serves. Kept mutable and read per-request so a
  // hot reload (which rebuilds options but reuses the running server) and the
  // most recent ensureUrl() caller both serve current tools/skills/permissions.
  options: McpServerOptions
}

const globalRef = globalThis as typeof globalThis & {
  __acpMcpServers?: Map<string, RunningServer>
}
if (!globalRef.__acpMcpServers) {
  globalRef.__acpMcpServers = new Map()
}
const servers = globalRef.__acpMcpServers

// One source of truth for the skill tool's name, description, and catalog
// formatting — reused by this MCP server and the native harness so both expose
// an identical skill instrument.
export const SKILL_TOOL_NAME = 'skill'

export const SKILL_INPUT_SCHEMA = {
  skill: z.string().describe('Name of the skill to load'),
}

// The catalog itself is served by the skill_list tool, not embedded here — a
// large skill count previously bloated this description enough to get
// truncated in tool listings.
export function skillToolDescription(): string {
  return 'Load a skill to learn how to perform a task. Call skill_list first to see available skills and when to use them.'
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

async function resolveSkills(skills: SkillsInput): Promise<SkillDef[]> {
  return typeof skills === 'function' ? skills() : skills
}

async function resolveTools(tools: ToolsInput): Promise<LocalTool[]> {
  return typeof tools === 'function' ? tools() : tools
}

// Build a request-scoped server. When permissions are resolved for the request,
// tools and skills the session can't reach are withheld from both tools/list
// and tools/call.
async function buildServer(
  options: McpServerOptions,
  permissions: ResolvedPermissions | undefined,
): Promise<McpServer> {
  const server = new McpServer({
    name: `agent-client-${options.name}`,
    version: '0.1.0',
  })
  const skills = (await resolveSkills(options.skills)).filter(
    (skill) => accessFor(permissions, skillKey(skill.name)) !== null,
  )
  const skillHandler = options.skillHandler
  if (skills.length > 0 && skillHandler) {
    server.registerTool(
      SKILL_TOOL_NAME,
      {
        description: skillToolDescription(),
        inputSchema: SKILL_INPUT_SCHEMA,
      },
      // Guard the handler too: a model could still name a non-permitted skill.
      async ({ skill }) => {
        if (accessFor(permissions, skillKey(skill)) === null) {
          return textResult(`Skill "${skill}" is not available.`)
        }
        return textResult(await skillHandler(skill))
      },
    )
  }
  for (const tool of await resolveTools(options.tools)) {
    if (accessFor(permissions, toolKey(tool.name)) === null) {
      continue
    }
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => toCallToolResult(await tool.handler(args)) as CallToolResult,
    )
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

function permissionsForRequest(options: McpServerOptions, req: IncomingMessage): ResolvedPermissions | undefined {
  const token = req.headers['x-agent-session']
  if (typeof token !== 'string' || !options.permissionsFor) {
    return undefined
  }
  return options.permissionsFor(token)
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function handle(running: RunningServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const permissions = permissionsForRequest(running.options, req)
  // The server listens on every interface (see ensureUrl below) so a harness
  // running in a sibling container can reach it. A missing/unresolved session
  // token means "unrestricted" (see accessFor), which was fine when this
  // server was loopback-only; now that it's reachable from other containers on
  // the same network, only a loopback caller keeps that trust — everyone else
  // must carry a token that actually resolves.
  if (!permissions && !isLoopbackAddress(req.socket.remoteAddress)) {
    res.statusCode = 403
    res.end()
    return
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => void transport.close())
  const server = await buildServer(running.options, permissions)
  await server.connect(transport)
  await transport.handleRequest(req, res, await readBody(req))
}

export function createMcpServer(options: McpServerOptions): McpServerHandle {
  return {
    async ensureUrl(): Promise<string> {
      const existing = servers.get(options.name)
      if (existing) {
        // Reuse the running server (survives hot reloads), but point it at this
        // caller's current options so the latest tools/skills/permissions win.
        existing.options = options
        return existing.url
      }
      let running: RunningServer
      const http = createServer((req, res) => {
        void handle(running, req, res).catch(() => {
          res.statusCode = 500
          res.end()
        })
      })
      await new Promise<void>((resolve) => {
        // Bound to every interface, not just loopback: a harness running via
        // `docker exec` in a sibling container (see resolve.ts wrapInDocker)
        // needs to reach this port from outside this process's own network
        // namespace. handle() above requires an authenticated token from any
        // caller that isn't loopback to compensate for the wider exposure.
        // This relies on the port staying ephemeral and unpublished — it must
        // never be mapped to the host's external interface in compose/run
        // config, or that exposure would extend past the docker network.
        http.listen(0, '0.0.0.0', resolve)
      })
      const address = http.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const url = `http://127.0.0.1:${port}/mcp`
      running = { http, url, options }
      servers.set(options.name, running)
      return url
    },

    async close(): Promise<void> {
      const running = servers.get(options.name)
      if (!running) {
        return
      }
      servers.delete(options.name)
      await new Promise<void>((resolve) => {
        running.http.close(() => resolve())
      })
    },
  }
}
