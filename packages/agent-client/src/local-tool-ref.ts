// Reading a harness's tool reference back to one of the host's OWN local tools.
//
// A permission request names the tool it is about, in the harness's vocabulary
// rather than the host's. An agent reaches the host's tools through the built-in
// MCP server, and the harnesses reached over ACP refer to an MCP tool as
// `mcp__<server>__<tool>` — so the server half is what says "this one is ours",
// and the tool half is the name the host registered it under.
//
// Anchored on the server name, not searched for anywhere in the string. Two
// different references can otherwise resolve onto a host tool that is not the
// one being called: a harness's own built-in tool arrives as a bare name that
// may coincide with a host tool's name, and another MCP server's tool is
// namespaced as well. Either would hand the caller a classification belonging to
// a different tool, which is a wrong permission decision — and it goes wrong in
// both directions, allowing what should prompt and prompting for what should
// not.
//
// An unrecognised reference resolves to nothing rather than to a guess. Nothing
// means "no declaration available here", which leaves the caller on whatever it
// decided before — the direction a gate has to fail in.

const NAMESPACE = '__'

/**
 * The host-registered name of a local tool, read off a harness's reference to
 * it; undefined when the reference is not one of this host's local tools (or
 * names no tool at all).
 *
 * `mcpServerName` is the name the built-in MCP server was given, which is the
 * only half of the reference the host can recognise as its own.
 */
export function localToolRef(reference: string | null | undefined, mcpServerName: string): string | undefined {
  const prefix = `mcp${NAMESPACE}${mcpServerName}${NAMESPACE}`
  if (!reference?.startsWith(prefix)) {
    return undefined
  }
  const name = reference.slice(prefix.length)
  return name.length > 0 ? name : undefined
}
