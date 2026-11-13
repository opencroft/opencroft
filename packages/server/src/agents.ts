/**
 * `@opencroft/server/agents` — an agent's instruction texts: its own, written
 * as the instruction file in its workspace, and the shared text of the place
 * it runs in (its container, or the server), written where every agent there
 * reads its home-level instructions. Each is written at every session open,
 * and an open thread is told at its next message.
 */

/** Which text: the place's `shared` one, the agent's own, or the Custom harness's system prompt. */
export type HostAgentInstructionRole = 'shared' | 'agent' | 'system-prompt'

/** One text the agent's harness reads. */
export interface HostAgentInstructionFile {
  role: HostAgentInstructionRole
  /** The file the text is written to, as configured; none for a system prompt. */
  path?: string
  /** For the shared text: its place (`container:<name>` or `host`), and the names of the agents there that read it. */
  place?: string
  sharedWith?: string[]
  /** Whether the harness reads the file every turn or once per session. */
  rereads?: 'turn' | 'session'
  text: string
  /** For the shared text: its version, what `write` takes back with `place` as `expected`. */
  version?: number
}

export interface HostAgentInstructions {
  agent: { nodeId: string; name: string }
  /** The harness's label. */
  harness: string
  /** One entry per text the harness reads; empty for a harness that keeps its own files. */
  files: HostAgentInstructionFile[]
  /** The group chats the agent is in, whose topic and pinned notes reach it too. */
  chats: { id: string; name: string }[]
}

/** What `write` did. */
export interface HostAgentInstructionsWrite {
  agent: string
  role: HostAgentInstructionRole
  /** For the shared text: its place, and the names of the agents there that read it. */
  place?: string
  sharedWith?: string[]
  /** For the shared text: its version after the write. */
  version?: number
  /**
   * Nothing was written: someone else saved the shared text after the
   * `expected` version was read. This is the text that is there now.
   */
  conflict?: { text: string; version: number; updatedBy?: string }
}

/**
 * Read and write an agent's instruction texts. Calls are not authorised here:
 * whatever invokes these must already hold the right to edit the agent node,
 * and for the shared text every agent in its place.
 */
export interface HostAgentInstructionsApi {
  /** The agent's texts and where its harness reads them. Rejects an id that is not an agent node. */
  read(agentNodeId: string): Promise<HostAgentInstructions>
  /**
   * Replace one text; an empty text removes its file. Rejects a role the
   * agent's harness does not read. For the shared text, the answer names who
   * else reads it. With `expected` (the shared file's `place` and `version`
   * as read), the shared text is replaced only there and only if nobody
   * saved it since: the write rejects if the agent has moved to another
   * place, and the answer's `conflict` holds the current text if someone
   * saved first.
   */
  write(
    agentNodeId: string,
    role: HostAgentInstructionRole,
    text: string,
    options?: { expected?: { place: string; version: number } },
  ): Promise<HostAgentInstructionsWrite>
}

/** An agent's instruction texts. */
export declare const agentInstructions: HostAgentInstructionsApi
