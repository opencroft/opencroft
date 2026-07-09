/**
 * Server-only contract for extension-contributed MCP tools.
 *
 * An extension declares each tool's metadata (name, description, JSON
 * Schema `inputSchema`, and optional `requireApproval`) as manifest
 * `provides.mcpTools` entries, so the host can list them without loading the
 * extension's bundle. The extension's server module then exports the
 * matching handlers as `export const tools: Record<string, ExtensionToolHandler>`,
 * keyed by tool name — analogous to `actions` and `routes`.
 *
 * A handler's return value becomes the MCP tool result: a `string` is
 * wrapped as `{ content: [{ type: 'text', text }] }`; any other value is
 * JSON-stringified into the same shape. A thrown error is surfaced to the
 * caller as a failed tool call.
 */
export type ExtensionToolHandler = (args: Record<string, unknown>) => Promise<unknown>
