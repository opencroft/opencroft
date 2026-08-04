import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

// Matches the userinfo portion of any http(s) URL appearing in text, e.g.
// "https://user:token@host/..." -> "https://host/...". Generic on purpose:
// this redacts whatever credential a caller embedded, not one known value,
// so it also covers a remote echoing the URL back in its own stderr.
const CREDENTIAL_URL_PATTERN = /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g

function redact(text: string): string {
  return text.replace(CREDENTIAL_URL_PATTERN, '$1')
}

export interface GitExecError extends Error {
  stdout?: string
  stderr?: string
}

// The only sanctioned way to shell out to git in this codebase. A command
// whose args embed a credentialed URL (a clone or ls-remote against a
// private repo) fails in exactly the way that makes Node put the full
// command line -- credential included -- into the rejection's own message,
// and a remote can echo the same URL back in stderr. Redacting once here, at
// the point the failure is constructed, means no caller has to remember to
// do it, and a future git-shelling call site inherits the same guarantee
// just by using this instead of execFile directly.
export async function runGit(
  args: string[],
  options: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', args, options)
  } catch (err) {
    const e = err as { message?: string; stdout?: string; stderr?: string }
    const redacted: GitExecError = new Error(redact(e.message ?? String(err)))
    if (e.stdout !== undefined) {
      redacted.stdout = redact(e.stdout)
    }
    if (e.stderr !== undefined) {
      redacted.stderr = redact(e.stderr)
    }
    throw redacted
  }
}
