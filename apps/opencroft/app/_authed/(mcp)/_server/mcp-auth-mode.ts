import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * How the HTTP MCP surface treats credentials.
 *
 *   off      — no resolution, no recording. As if this work had not landed.
 *   observe  — resolve and record, refuse nothing. Stage A.
 *   require  — refuse callers without a valid token. Stage B.
 *
 * `OPENCROFT_MCP_AUTH` picks the mode at startup. The KILL SWITCH FILE
 * overrides it to `off` at any time, without a restart.
 *
 * WHY A FILE AND NOT JUST THE ENV VAR
 *
 * `/api/mcp` is the dispatch path — it is how work reaches agents and how node
 * actions run. If `require` is wrong about the caller population, agents stop
 * working *and cannot be told that they have*. So the recovery path must not
 * pass through anything this change can take out.
 *
 * The Application node's `env` fails that test: it lives in the graph, and the
 * graph is edited through the app — through MCP for an agent, through a
 * session-gated page for a person. Changing it also needs a restart, and on
 * a git-based deployment a restart is a `git pull && npm install`,
 * which has its own ways to fail.
 *
 * A file on the data volume needs none of that. `/app` is bind-mounted from
 * the repository checkout, so the switch can be thrown straight from the workspace:
 *
 *     touch apps/opencroft/data/mcp-auth-off
 *
 * or, from a host with Docker access:
 *
 *     docker exec <container> touch /app/apps/opencroft/data/mcp-auth-off
 *
 * The first form works even against a container that will not start, which is
 * the case the env var cannot reach at all. Delete the file to re-enable; no
 * restart either way.
 */
export type McpAuthMode = 'off' | 'observe' | 'require'

const ENV_MODE: McpAuthMode = (() => {
  const raw = process.env.OPENCROFT_MCP_AUTH
  if (raw === 'off' || raw === 'observe' || raw === 'require') {
    return raw
  }
  // Unset or misspelled falls back to `observe`, which cannot refuse anything.
  // A typo in this variable must not be a way to switch enforcement on or off
  // by accident — in either direction.
  return 'observe'
})()

// The data volume, matching how packages/db resolves PGLITE_PATH.
const DATA_DIR = process.env.OPENCROFT_DATA_DIR ?? path.join(process.cwd(), 'data')
export const KILL_SWITCH_PATH = path.join(DATA_DIR, 'mcp-auth-off')

// Checked per request, so cache it — but briefly. This is the number that
// decides how long someone waits during an incident after creating the file,
// so it is deliberately short rather than tuned for the happy path.
const CACHE_MS = 3000

let cachedAt = 0
let cachedKilled = false

function killSwitchPresent(): boolean {
  const now = Date.now()
  if (now - cachedAt < CACHE_MS) {
    return cachedKilled
  }
  cachedAt = now
  try {
    cachedKilled = existsSync(KILL_SWITCH_PATH)
  } catch {
    // An unreadable data directory must not decide policy by itself. Fall back
    // to the configured mode and let the surface behave as deployed.
    cachedKilled = false
  }
  return cachedKilled
}

/** The mode in force right now, kill switch included. */
export function mcpAuthMode(): McpAuthMode {
  return killSwitchPresent() ? 'off' : ENV_MODE
}

/** Where the mode came from — for diagnostics that ask "why is this off?". */
export function mcpAuthModeInfo(): { mode: McpAuthMode; configured: McpAuthMode; killSwitch: boolean } {
  const killSwitch = killSwitchPresent()
  return { mode: killSwitch ? 'off' : ENV_MODE, configured: ENV_MODE, killSwitch }
}

/** Testing seam — the cache would otherwise hide a file created mid-test. */
export function resetKillSwitchCache(): void {
  cachedAt = 0
  cachedKilled = false
}
