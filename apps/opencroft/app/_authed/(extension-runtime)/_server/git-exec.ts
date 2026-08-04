import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  options: { maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
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

export interface GitCredentials {
  username: string
  token: string
}

/**
 * Resolves a credential for a `runGit` read (clone/ls-remote) to a
 * username-only URL plus a `GIT_ASKPASS` env, instead of splicing the token
 * into the URL string. A token in the URL sits in the argv of `git` and of
 * the `git-remote-https` helper it spawns -- readable by anything on the
 * host via `ps`/`/proc/<pid>/cmdline` for as long as either runs, whether
 * the command succeeds or fails. The env
 * carries the token instead; only the username (never secret) reaches argv.
 *
 * Call the returned `cleanup` once the git command has finished -- it
 * removes the temporary askpass script. `creds: null` (no auth configured)
 * passes the URL through unchanged with no env override.
 */
export async function withGitAuth(
  url: string,
  creds: GitCredentials | null,
): Promise<{ url: string; env: NodeJS.ProcessEnv | undefined; cleanup: () => Promise<void> }> {
  if (!creds) {
    return { url, env: undefined, cleanup: async () => {} }
  }
  const parsed = new URL(url)
  parsed.username = encodeURIComponent(creds.username)
  parsed.password = ''

  const dir = await mkdtemp(path.join(tmpdir(), 'git-askpass-'))
  const scriptPath = path.join(dir, 'askpass.sh')
  await writeFile(scriptPath, '#!/bin/sh\nprintf \'%s\' "$GIT_ASKPASS_PASSWORD"\n', { mode: 0o700 })
  return {
    url: parsed.toString(),
    env: { ...process.env, GIT_ASKPASS: scriptPath, GIT_ASKPASS_PASSWORD: creds.token },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
