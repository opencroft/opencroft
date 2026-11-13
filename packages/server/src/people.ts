/**
 * `@opencroft/server/people` — the accounts on the instance: the people and
 * agent directories, what each agent is doing, who a text mentions, and
 * agents' MCP tokens.
 */

/** One person in the user directory. Three fields by design: never an email, role or sign-in state. */
export interface HostUser {
  id: string
  name: string
  avatarUrl: string | null
}

/** The people directory — what any signed-in member may already see of every account. */
export interface HostUsersApi {
  /** Every account, ordered by name. */
  list(): Promise<HostUser[]>
}

/** One agent in the agent directory: its node id, name and avatar — the ones the group chat shows. Nothing else. */
export interface HostAgent {
  id: string
  name: string
  avatarUrl: string | null
}

/**
 * What one agent is doing, over all its group-chat threads, read from the
 * same session states the chat's thread status rings show.
 */
export interface HostAgentPresence {
  agentNodeId: string
  /**
   * The first of these that any of its threads is in. `waiting`: a turn is
   * blocked on a person (a permission request or a question), as the chat's
   * Waiting. `working`: a turn or its background work is in flight.
   * `compacting`: threads are active, and every one of them is compacting its
   * context. `idle`: a thread has a live session and none is active.
   * `offline`: no thread has a live session.
   */
  status: 'idle' | 'working' | 'waiting' | 'compacting' | 'offline'
  /** Threads with a turn, background work or a compaction in flight. */
  activeThreads: number
  /** ISO time of the last event any of its threads' sessions had; null when none ever had one. */
  lastActiveAt: string | null
}

/** The agent directory — every Agent node of every space, the agents' counterpart of `HostUsersApi`. */
export interface HostAgentsApi {
  /** Every agent, ordered by name. */
  list(): Promise<HostAgent[]>
  /** The presence of every agent `list` gives, in the same order. */
  presence(): Promise<HostAgentPresence[]>
  /**
   * Hear an agent's presence each time its `status` or `activeThreads`
   * changes, with no polling; `lastActiveAt` alone changing is not a change.
   * Returns the unsubscribe. A subscription made from the server module ends
   * when the module is unloaded, whether or not the extension unsubscribed.
   */
  subscribePresence(listener: (presence: HostAgentPresence) => void | Promise<void>): () => void
}

/** One account a text mentions: a person (`kind: 'user'`, `id` their account id) or an agent (`id` its node id). */
export interface HostMention {
  kind: 'user' | 'agent'
  id: string
  name: string
  avatarUrl: string | null
  /** The username it was mentioned by. */
  username: string
}

/**
 * Mentions in markdown, by the rule every rendered text follows: `@<username>`
 * in prose is a mention and renders as a mention chip; a display name is not
 * one, and inline code, a code block, raw HTML and a link's own label never
 * mention. What renders as a mention chip is exactly what this finds.
 */
export interface HostMentionsApi {
  /** The accounts `markdown` mentions, in order, each once. A username no account holds mentions nobody. */
  find(markdown: string): Promise<HostMention[]>
}

/** One of an agent node's MCP tokens, as listed. Dates are ISO strings; a null `expiresAt` never expires. The token itself is not here and cannot be read back. */
export interface HostMcpTokenInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

/**
 * The credentials that identify an agent node on the MCP endpoint. A token is
 * issued to one agent node and authenticates as that agent there and nowhere
 * else. Calls are not authorised here -- whatever invokes these must already
 * have established a signed-in person, because issuing a token is issuing an
 * agent's identity.
 */
export interface HostMcpTokensApi {
  /** The node's tokens, newest first. */
  list(agentNodeId: string): Promise<HostMcpTokenInfo[]>
  /** Issue a token; `expiresAt` null means it never expires. The plaintext `token` is returned here once and never again. Refused when the node is not an agent. */
  create(agentNodeId: string, input: { name: string; expiresAt: string | null }): Promise<{ id: string; token: string }>
  /** Delete one of the node's tokens. It stops working on the next request that presents it. */
  delete(agentNodeId: string, id: string): Promise<void>
}

/** The people directory: id, name and avatar of every account. */
export declare const users: HostUsersApi
/** The agent directory: id, name and avatar of every agent, and what each is doing. */
export declare const agents: HostAgentsApi
/** Who a markdown text mentions. */
export declare const mentions: HostMentionsApi
export declare const mcpTokens: HostMcpTokensApi
