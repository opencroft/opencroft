import { hostname } from 'node:os'

// The internal MCP server advertises 127.0.0.1 by default, since it normally
// shares the harness's own network namespace. That breaks once the harness runs
// in a sibling container: 127.0.0.1 inside that container is its own loopback,
// not this process's. Docker's embedded DNS resolves this container's own
// name/hostname for any sibling on the same user-defined network, so swap in
// our hostname (Docker sets it to the short container id by default, which is
// one of those resolvable names) — this assumes this process runs in a
// container on the same user-defined network as the target, which holds for a
// compose-managed deployment but not every embedder of this package.
// AGENT_CLIENT_MCP_ADVERTISE_HOST overrides it for setups where that assumption
// doesn't hold (e.g. the host process runs on bare metal, or the target
// container is on a different network).
//
// This lives apart from the spawn/adapter lookups in `resolve.ts` because of
// the `node:os` import above: those lookups are imported by client components
// (the preset form reads the provider and adapter tables), and a module they
// import may not reach for a node builtin at the top level — the bundler
// externalizes it and the page fails at runtime on first access.
export function containerReachableMcpUrl(url: string): string {
  const host = process.env.AGENT_CLIENT_MCP_ADVERTISE_HOST || hostname()
  return url.replace('127.0.0.1', host)
}
