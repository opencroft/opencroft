// Whether a harness could start in a place it runs in apart from this process
// (a host's RemoteShell): its launcher is there, and its model endpoint
// answers from there. A harness started where its launcher is missing fails
// with the shell's own words ("npx: not found") after the session has begun
// opening; these ask first, so a host can say what is missing and where,
// before a session or as soon as a place is picked. The probes only look
// commands up and make one unauthenticated request: they install, write,
// cache and leave running nothing there.

import type { ShellRunner } from './harness-process'
import { findAdapter } from './resolve'

/** The commands an adapter's harness needs on the PATH where it is started. */
export function launcherCommands(adapterId: string): string[] {
  const command = findAdapter(adapterId)?.command ?? 'npx'
  // npx is a Node.js script: the launcher is there only when node is too.
  return command === 'npx' ? ['node', 'npx'] : [command]
}

/**
 * The adapter's launcher commands the shell `run` reaches does not find, in
 * the shell and PATH a harness started there gets. Empty when all are there.
 */
export async function missingLauncherCommands(run: ShellRunner, adapterId: string): Promise<string[]> {
  const commands = launcherCommands(adapterId)
  const script = `for c in ${commands.map(shellQuote).join(' ')}; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done`
  const printed = (await run(script, '', {})).split('\n').map((line) => line.trim())
  return commands.filter((command) => printed.includes(command))
}

/** What a person reads when a harness cannot start in `where` for lack of `missing`. */
export function missingLauncherMessage(missing: string[], where: string): string {
  const what = missing.some((command) => command === 'node' || command === 'npx')
    ? 'Node.js (npx)'
    : missing.join(', ')
  return `${what} isn't available in ${where}; install it there or put it on the non-interactive PATH.`
}

/** Whether a model endpoint answered from a place, and how it failed when it did not. */
export type EndpointReach = { reachable: true; status: number } | { reachable: false; reason: string }

// How long the probe waits for an endpoint before calling it unreachable.
const ENDPOINT_TIMEOUT_MS = 5_000

// A GET of the URL with no credentials and a timeout. Any HTTP answer, a 401
// or 404 included, means the endpoint is reachable; only a failure to connect
// (DNS, refused, timeout) means it is not. It prints one line and exits.
const ENDPOINT_PROBE = `fetch(process.argv[1], { signal: AbortSignal.timeout(${ENDPOINT_TIMEOUT_MS}) }).then((r) => console.log('reachable ' + r.status), (e) => console.log('unreachable ' + ((e.cause && e.cause.code) || e.name || 'error')))`

/**
 * Whether `url` answers from the place the shell `run` reaches, asked with
 * that place's own Node (`node -e`). No key or header is sent, so nothing
 * secret is on its command line or reaches the far side; nothing is written
 * or left running there.
 */
export async function endpointReach(run: ShellRunner, url: string): Promise<EndpointReach> {
  const printed = (await run(`node -e ${shellQuote(ENDPOINT_PROBE)} ${shellQuote(url)}`, '', {})).trim()
  const [verdict, detail = ''] = printed.split(/\s+/, 2)
  if (verdict === 'reachable') {
    return { reachable: true, status: Number(detail) }
  }
  return { reachable: false, reason: verdict === 'unreachable' ? detail : printed || 'no answer' }
}

/** What a person reads about the endpoint's reach from `where`. */
export function endpointReachMessage(url: string, reach: EndpointReach, where: string): string {
  return reach.reachable
    ? `The model endpoint ${url} is reachable from ${where}.`
    : `The model endpoint ${url} can't be reached from ${where} (${reach.reason}).`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
