/**
 * Who a tool call is on behalf of.
 *
 * Its own module, dependency-free, for the same reason `access-error.ts` is:
 * the tool registry and the approval wrapper both need this type, and the
 * registry already imports the wrapper. Declaring it in either one would make
 * the other import back into it — a cycle to satisfy a type that carries no
 * behaviour at all.
 *
 * `agent` is the agent NAME the calling surface resolved — the name of the node
 * the request's MCP token was issued to over HTTP, the session's own
 * bookkeeping in the in-process bridge — or null when it resolved none: a
 * bridged session that could not be attributed to exactly one agent. (The HTTP
 * endpoint refuses a request with no valid token before any tool runs, so an
 * HTTP call always carries an agent.)
 *
 * `agentNodeId` is set only where the surface identified the agent by its NODE
 * rather than by name — the HTTP endpoint, whose tokens are issued per node.
 * Where it is present it is the identity and `agent` is only what to call it:
 * names are free text two nodes can share, and a lookup by name could land on
 * the other one. The bridge has no credential and sets only `agent`.
 *
 * NULL IS "UNKNOWN", NOT "TRUSTED". A tool that acts on behalf of a specific
 * agent refuses a caller with neither rather than falling back to a default —
 * there is no safe default for "which agent is this".
 *
 * `sessionId` is the calling session's id, asserted the same way: the
 * in-process bridge has it from the session's own bookkeeping, and the HTTP
 * surface never has one. It is what a tool that must reach back INTO the
 * calling conversation keys on — a background task delivers its result there.
 *
 * ABSENT IS "NO SESSION", NOT "SOME SESSION". Same contract as `agent`: a tool
 * that needs one says there is none rather than picking one, and a value taken
 * from tool arguments would let any caller post into any conversation.
 *
 * `signal` is the one field no surface sets. The registry adds it when it runs
 * the call as a background task — the tool is declared `async`, or `awaitable`
 * and called with `background: true` — and it aborts when that task is
 * cancelled or runs out of time. A call run in place never carries one.
 *
 * ADVISORY, NOT A STOP. Nothing halts a handler from outside: one that watches
 * the signal can end early, one that ignores it runs on to its end — which is
 * why a cancel of such a task reports that it asked, not that it stopped. A
 * handler does not have to look at it to be run in the background.
 */
export interface ToolCallerContext {
  agent: string | null
  agentNodeId?: string
  sessionId?: string
  /** Only while the call runs as a background task — see above. */
  signal?: AbortSignal
}

/** Every tool handler's shape: the call's arguments, and who is making it. */
export type ToolHandler = (args: Record<string, unknown>, caller: ToolCallerContext) => Promise<Record<string, unknown>>
