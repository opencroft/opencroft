// The one id scheme for graph nodes and edges, whoever creates them: the
// canvas (drop, connect, paste) and the agent-facing tools alike. Ids used to
// differ by author -- `<typeId>_<8 chars>` from the canvas, a UUID from MCP --
// so an id said who made the node and nothing more. What a user should see is
// a node's name, resolved from the id (see NodeRef/TerminalRef), not the id.
export function newGraphId(): string {
  return crypto.randomUUID()
}
