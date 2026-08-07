/**
 * Who a tool call is on behalf of.
 *
 * Its own module, dependency-free, for the same reason `access-error.ts` is:
 * the tool registry and the approval wrapper both need this type, and the
 * registry already imports the wrapper. Declaring it in either one would make
 * the other import back into it — a cycle to satisfy a type that carries no
 * behaviour at all.
 *
 * `agent` is the agent NAME the calling surface resolved — from the request's
 * credential over HTTP, from the session's own bookkeeping in the in-process
 * bridge — or null when it resolved none: no credential presented, a personal
 * token, auth switched off, or a bridged session that could not be attributed
 * to exactly one agent.
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
