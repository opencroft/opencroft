/**
 * Who a tool call is on behalf of.
 *
 * Its own module, dependency-free, for the same reason `access-error.ts` is:
 * the tool registry and the approval wrapper both need this type, and the
 * registry already imports the wrapper. Declaring it in either one would make
 * the other import back into it — a cycle to satisfy a type that carries no
 * behaviour at all.
 *
 * `agent` is the agent NAME behind the credential the HTTP MCP surface
 * resolved, or null when there is none: no credential presented, a personal
 * token, auth switched off, or the in-process bridge, which has no credential
 * because it never leaves the process.
 *
 * NULL IS "UNKNOWN", NOT "TRUSTED". A tool that acts on behalf of a specific
 * agent refuses a null caller rather than falling back to a default — there is
 * no safe default for "which agent is this".
 */
export interface ToolCallerContext {
  agent: string | null
}

/** Every tool handler's shape: the call's arguments, and who is making it. */
export type ToolHandler = (args: Record<string, unknown>, caller: ToolCallerContext) => Promise<Record<string, unknown>>
