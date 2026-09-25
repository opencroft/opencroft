// Where an agent's harness runs and keeps its files, derived from the agent
// node alone. Two readers must agree on it exactly: the host's session engine,
// which spawns the agent (acp-impl.ts in (agent)), and the account sign-in in
// this extension's server, which writes the harness's login into the home
// those sessions read. No node builtins here, like every *-shared module; the
// host-side paths are joined by the caller's own path module.

export interface AgentPlacement {
  // Per-agent directory name: the agent's name slugged, else its node id.
  slug: string
  // The harness's workdir: /agents/<slug> in a container, else a persistent
  // directory in the data volume.
  cwd: string
  // A directory for the harness's own state (Codex's CODEX_HOME), beside the
  // workspace rather than in it, so a harness that sandboxes writes to its
  // workdir (Codex's default modes) can't edit its own config, and not in the
  // server user's home, so nothing kept there reaches it.
  harnessHome: string
  // Set when the harness runs inside this Docker container via `docker exec`.
  containerName?: string
}

function agentSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function agentPlacement(
  agent: { name?: string; containerName?: string },
  nodeId: string,
  // The server process's working directory, which holds the data volume for
  // host-run agents, and the path join of the machine that runs them.
  host: { cwd: string; join: (...parts: string[]) => string },
): AgentPlacement {
  const slug = agentSlug(agent.name ?? '') || nodeId
  const containerName = agent.containerName || undefined
  if (containerName) {
    // Container paths are POSIX whatever the server runs on.
    return { slug, cwd: `/agents/${slug}`, harnessHome: `/agents/.harness-home/${slug}`, containerName }
  }
  return {
    slug,
    cwd: host.join(host.cwd, 'data', 'agent-workspace', slug),
    harnessHome: host.join(host.cwd, 'data', 'agent-harness-home', slug),
  }
}
