// Where an agent's harness runs and keeps its files, derived from the agent
// node alone. Two readers must agree on it exactly: the host's session engine,
// which spawns the agent (acp-impl.ts in (agent)), and the account sign-in in
// this extension's server, which writes the harness's login into the home
// those sessions read. No node builtins here, like every *-shared module; the
// host-side paths are joined by the caller's own path module.

import type { HarnessProcess, RemoteShell } from 'agent-client/types'

export interface AgentPlacement {
  // Per-agent directory name: the agent's name slugged, else its node id.
  slug: string
  // The harness's workdir: the node's Folder on its terminal, empty for the
  // terminal's own directory until placementOnTerminal names it. Without a
  // terminal, a persistent directory in the data volume: the Custom
  // harness's, which runs in this process and uses no terminal (every other
  // harness needs one).
  cwd: string
  // A directory for the harness's own state (Codex's CODEX_HOME), beside the
  // workspace rather than in it, so a harness that sandboxes writes to its
  // workdir (Codex's default modes) can't edit its own config, and not in the
  // server user's home, so nothing kept there reaches it.
  harnessHome: string
  // Set when the harness runs through the terminal picked on the node: its
  // `<node-id>/<handle-id>` target, with `cwd` the node's Folder there.
  terminal?: string
}

/** What an agent's terminal shell needs from the server it runs on. */
export interface AgentTerminalDeps<C> {
  getContext(nodeId: string, handleId: string): Promise<C>
  agentRefusalOf(ctx: C): string | null
  spawn(ctx: C, argv: string[], opts: { env: Record<string, string> }): Promise<HarnessProcess>
  // The terminal's owner as a person knows it (its node's or App's name).
  ownerName?(target: string): Promise<string | undefined>
}

/**
 * agent-client's RemoteShell for the terminal `target`: each process starts
 * on the context the target resolves to at that moment, so a terminal whose
 * source changed is followed. A context its source refused to agents is
 * refused here too, with the source's reason.
 */
export function agentTerminalShell<C>(
  target: string,
  deps: AgentTerminalDeps<C>,
  mcpUrl: (loopbackUrl: string) => string,
): RemoteShell {
  const slash = target.indexOf('/')
  const nodeId = target.slice(0, slash)
  const handleId = target.slice(slash + 1)
  return {
    id: target,
    async spawn(argv, env) {
      const ctx = await deps.getContext(nodeId, handleId)
      const refusal = deps.agentRefusalOf(ctx)
      if (refusal) {
        throw new Error(refusal)
      }
      return deps.spawn(ctx, argv, { env })
    },
    mcpUrl,
    async describe() {
      const name = await deps.ownerName?.(target)
      return name ? `terminal "${name}"` : `terminal ${target}`
    },
  }
}

/** The node error source of the placement move, for an agent it could not move to a terminal. */
export const AGENT_PLACEMENT_ERROR_SOURCE = 'agent-placement'

/** An agent's directory name from its name; empty when nothing of it is usable. */
export function agentSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function agentPlacement(
  agent: { name?: string; terminal?: string; terminalFolder?: string },
  nodeId: string,
  // The server process's working directory, which holds the data volume for
  // host-run agents, and the path join of the machine that runs them.
  host: { cwd: string; join: (...parts: string[]) => string },
): AgentPlacement {
  const slug = agentSlug(agent.name ?? '') || nodeId
  const terminal = agent.terminal?.trim() || undefined
  if (terminal) {
    // The folder is a path on that terminal, POSIX whatever the server runs
    // on. Empty when unset: the terminal's own directory, which only the
    // terminal can name (placementOnTerminal).
    const folder = (agent.terminalFolder ?? '').trim().replace(/(.)\/+$/, '$1')
    // Beside the folder, so an agent moved off a container (Folder
    // /agents/<slug>, placement-migration.ts) keeps the home it had there.
    // A relative folder is one in the terminal's own directory.
    const parent = folder.includes('/') ? folder.replace(/\/[^/]*$/, '') : '.'
    return { slug, cwd: folder, harnessHome: folder ? `${parent}/.harness-home/${slug}` : '', terminal }
  }
  return {
    slug,
    cwd: host.join(host.cwd, 'data', 'agent-workspace', slug),
    harnessHome: host.join(host.cwd, 'data', 'agent-harness-home', slug),
  }
}

/** An agent's Folder is not a directory on its terminal; the message says so in plain words. */
export class FolderMissingError extends Error {}

/**
 * The placement as it is on the agent's terminal, asked through `run` (a
 * script in the terminal's shell, started in the terminal's own directory).
 * An empty Folder becomes that directory: a worktree terminal's worktree, a
 * container's WORKDIR, an SSH login's home. Its harness home is then under
 * the shell's $HOME, a place the terminal's user can write to, which the
 * parent of its directory need not be (`/home` above an SSH home). A Folder
 * that is not a directory there throws FolderMissingError, naming the
 * terminal as `where`. A placement without a terminal is returned unchanged.
 */
export async function placementOnTerminal(
  placement: AgentPlacement,
  run: (script: string, stdin: string, env: Record<string, string>) => Promise<string>,
  where: string,
): Promise<AgentPlacement> {
  if (!placement.terminal) {
    return placement
  }
  const folder = placement.cwd
  const script = folder
    ? `CDPATH= cd -- ${shellQuote(folder)} >/dev/null 2>&1 || echo missing`
    : 'printf "cwd:%s\\nhome:%s\\n" "$(pwd)" "$HOME"'
  const lines = (await run(script, '', {})).split('\n').map((line) => line.trim())
  if (folder) {
    if (lines.includes('missing')) {
      throw new FolderMissingError(folderMissingMessage(folder, where))
    }
    return placement
  }
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1) ?? ''
  const cwd = field('cwd')
  if (!cwd.startsWith('/')) {
    throw new Error(`${where} did not say which directory its shell starts in.`)
  }
  const home = field('home').startsWith('/') ? field('home') : cwd
  return { ...placement, cwd, harnessHome: `${home.replace(/\/+$/, '')}/.harness-home/${placement.slug}` }
}

/** What a person reads when an agent's Folder is not a directory on its terminal. */
export function folderMissingMessage(folder: string, where: string): string {
  return `The folder ${folder} does not exist on ${where}. Create it there, or leave Folder empty to work in the terminal's own directory.`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
