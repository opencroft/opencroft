/**
 * MCP tools contributed by extensions.
 *
 * Metadata (name/description/inputSchema/requireApproval) comes from each
 * extension's manifest `provides.mcpTools`, read via `getProvided` — no
 * bundle load required to list tools. The handler itself lives in the
 * extension's server module as `export const tools`, keyed by tool name,
 * and is only loaded (via `getExtensionModule`) when the tool is called.
 */

import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { getProvided } from '@/app/_authed/(extension-runtime)/_server/provides'

export interface ExtensionToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  extensionId: string
  requireApproval: boolean
}

interface RawMcpToolManifestEntry {
  name?: string
  description?: string
  inputSchema?: Record<string, unknown>
  requireApproval?: boolean
}

/**
 * Enumerate extension-contributed MCP tools. `reservedNames` are the static
 * core tool names (and, if the caller threads them through, agent-tool
 * names) — entries colliding with a reserved name are skipped, and static
 * tools always win. Among extensions, the first one to declare a given tool
 * name wins; later duplicates are skipped.
 */
export async function getExtensionToolDefinitions(
  reservedNames: Set<string> = new Set(),
): Promise<ExtensionToolDefinition[]> {
  const provided = await getProvided<RawMcpToolManifestEntry>('mcpTools')
  const defs: ExtensionToolDefinition[] = []
  const seen = new Set(reservedNames)

  for (const { extensionId, value } of provided) {
    const name = value.name?.trim()
    if (!name) {
      continue
    }
    if (seen.has(name)) {
      continue
    }
    seen.add(name)

    defs.push({
      name,
      description: value.description ?? `Extension tool: ${name}`,
      inputSchema: value.inputSchema ?? { type: 'object', properties: {} },
      extensionId,
      requireApproval: value.requireApproval ?? false,
    })
  }

  return defs
}

/**
 * Run an extension-contributed tool handler and wrap the result per the MCP
 * tool-call contract: a string result becomes plain text content, anything
 * else is JSON-stringified. Throws if the extension has no `tools[name]`
 * handler — the caller (handleToolCall) treats that like any other tool
 * error.
 */
export async function executeExtensionTool(
  extensionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mod = await getExtensionModule(extensionId)
  const handler = mod.tools?.[name]
  if (!handler) {
    throw new Error(`Extension "${extensionId}" has no tool handler for "${name}".`)
  }

  const result = await handler(args)
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}
