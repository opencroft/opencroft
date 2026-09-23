/**
 * Server-only contract for extension-contributed MCP tools.
 *
 * An extension declares each tool's metadata — {@link McpToolMeta} — as a
 * manifest `provides.mcpTools` entry, so the host can list it without loading
 * the extension's bundle. The extension's server module then exports the
 * matching handlers as `export const tools: Record<string, ExtensionToolHandler>`,
 * keyed by tool name — analogous to `actions` and `routes`.
 *
 * A handler's return value becomes the MCP tool result: a `string` is
 * wrapped as `{ content: [{ type: 'text', text }] }`; any other value is
 * JSON-stringified into the same shape. A thrown error is surfaced to the
 * caller as a failed tool call.
 *
 * A handler is written the same whatever its entry's `execution` says. When a
 * call runs as a background task, the host runs that same handler detached:
 * the text its return value becomes is the task's result, delivered to the
 * caller when the task ends, and a throw fails the task with the error's
 * message. The handler never sees a task id and never starts a task itself.
 */

import type { ExecutionMode } from '@opencroft/core'

/** One `provides.mcpTools` entry in an extension's manifest. */
export interface McpToolMeta {
  /**
   * The name callers see, and the key of its handler in `tools`. A name a
   * built-in tool already has is skipped, and so is one an earlier extension
   * declared.
   */
  name: string
  /** What the tool does, shown to the caller. */
  description?: string
  /** JSON Schema for the tool's arguments. */
  inputSchema?: Record<string, unknown>
  /** Queue every call for a person's approval on a surface that asks for one. */
  requireApproval?: boolean
  /**
   * How a caller waits for it — see {@link ExecutionMode}. Absent means `sync`.
   *
   * - `awaitable`: the host adds `background` and `timeoutMinutes` to the
   *   listed schema. A call with `background: true` answers at once with a task
   *   id while the handler runs on, and the result reaches the caller when it
   *   ends. The handler never receives either parameter.
   * - `async`: every call runs that way. The schema is listed as declared, and
   *   one sentence in the description says the answer comes later.
   *
   * Worth declaring for anything that may outlast the ~2 minutes a caller can
   * wait on one call. Nothing else is needed: the handler stays as it is.
   */
  execution?: ExecutionMode
}

export type ExtensionToolHandler = (args: Record<string, unknown>) => Promise<unknown>
