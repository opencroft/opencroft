import path from 'node:path'

import { installNodeDeps, readSidecar, resolveAuth } from '@/app/_authed/(extension-editor)/_actions/extension-checkout'
import {
  compileLocalExtensionImpl,
  getLocalExtensionImpl,
  type LocalExtensionRecord,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions-impl'
import { readCheckoutState } from '@/app/_authed/(extension-runtime)/_server/checkout-state'
import { runGit, withGitAuth } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { localExtRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { BuildResult } from '@/app/_authed/(extension-runtime)/_types'

// A local extension is a git checkout on this instance, and its branch moves
// on without it. This is the pair that answers that: what origin has, and
// bringing the checkout to it.
//
// Deliberately two operations rather than one. The check is a read against the
// remote and costs a round trip; the update rewrites the working tree, runs
// npm and republishes the bundle this instance is running. Folding them into
// "update if needed" would make the cheap question carry the expensive act.
//
// The files this module contains no server function — see
// scripts/check-server-fn-colocation.mjs; the wrappers live in
// local-extensions-actions.ts and call straight through.

/** Where a local checkout stands against its remote branch. */
export interface LocalRemoteState {
  /** The branch the checkout is on, "HEAD" when detached, null when unknown. */
  branch: string | null
  /** The commit the checkout is at. */
  localCommit: string | null
  /** What origin has for that branch, or null when the read did not happen. */
  remoteCommit: string | null
  /** origin's commit is one this checkout does not have. */
  behind: boolean
  /**
   * Why updating is not offered, in the sentence the page shows. Null when it
   * is. Stated even when there is nothing to update to, because it is the
   * answer to "why is this button off" either way.
   */
  blocked: string | null
  /** The check itself failed — offline, no remote, a credential. */
  error: string | null
}

export interface LocalPullResult {
  record: LocalExtensionRecord
  /** The commit the checkout was on before, and the one it is on now. */
  from: string | null
  to: string | null
  /** Whether the pull moved anything at all. */
  moved: boolean
  /** The rebuild that followed — this instance runs what the checkout holds,
   *  so a pull that is not compiled has changed nothing anyone can see. */
  build: BuildResult
}

function slugFromId(extensionId: string): string {
  const [scope, slug] = extensionId.split('/')
  if (scope !== 'local' || !slug) {
    throw new Error(`Expected local/<slug>, got "${extensionId}"`)
  }
  return slug
}

/** The remote a checkout updates from: the URL the install recorded, falling
 *  back to whatever `origin` points at for one that was cloned by hand. */
async function remoteUrl(dir: string): Promise<string | null> {
  const sidecar = await readSidecar(dir)
  if (sidecar?.source.url) {
    return sidecar.source.url
  }
  try {
    const { stdout } = await runGit(['-C', dir, 'remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function credentialsFor(dir: string) {
  const sidecar = await readSidecar(dir)
  return resolveAuth(sidecar?.auth)
}

/**
 * The environment a git call against the remote runs in.
 *
 * `GIT_TERMINAL_PROMPT=0` because there is no terminal here: without it a
 * credential git cannot resolve leaves the call waiting for a prompt nobody
 * can answer, and the page waits with it. With it, the call fails and the
 * failure is what the page shows.
 *
 * Built from `withGitAuth`'s env when there is one, and from this process's
 * otherwise — never from an empty object, which would hand git a PATH-less
 * environment. Whether an ambient credential helper is cleared stays
 * `effectiveGitArgs`'s decision, and it keys on GIT_ASKPASS being present,
 * which this preserves either way.
 */
function gitEnvFor(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0' }
}

/** Why this checkout cannot be updated right now, or null when it can. */
function blockedReason(branch: string | null, dirty: boolean | null, dirtyPaths: string[]): string | null {
  if (dirty === true) {
    const count = dirtyPaths.length
    return `The working tree carries ${count} uncommitted file${count === 1 ? '' : 's'}. Commit or discard them first.`
  }
  if (!branch || branch === 'HEAD') {
    return 'The checkout is not on a branch, so there is nothing to fast-forward.'
  }
  return null
}

export async function checkLocalExtensionRemoteImpl(extensionId: string): Promise<LocalRemoteState> {
  const dir = path.join(localExtRoot(), slugFromId(extensionId))
  const state = await readCheckoutState(dir)
  const base: LocalRemoteState = {
    branch: state.branch,
    localCommit: state.sourceCommit,
    remoteCommit: null,
    behind: false,
    blocked: blockedReason(state.branch, state.sourceDirty, state.sourceDirtyPaths),
    error: null,
  }
  if (!state.sourceCommit) {
    return { ...base, error: 'Not a git checkout, so there is no branch to follow.' }
  }
  if (!state.branch || state.branch === 'HEAD') {
    return base
  }
  const url = await remoteUrl(dir)
  if (!url) {
    return { ...base, error: 'This checkout has no remote to check.' }
  }
  let creds: Awaited<ReturnType<typeof credentialsFor>>
  try {
    creds = await credentialsFor(dir)
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
  const { url: authedUrl, env, cleanup } = await withGitAuth(url, creds)
  let remoteCommit: string | null
  try {
    // ls-remote rather than fetch: this runs every time an extension is
    // opened, and asking the question should not write objects into somebody's
    // checkout. The objects are fetched when they are actually wanted.
    const { stdout } = await runGit(['-C', dir, 'ls-remote', authedUrl, state.branch], { env: gitEnvFor(env) })
    remoteCommit = stdout.split('\n')[0]?.split('\t')[0]?.trim() || null
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await cleanup()
  }
  if (!remoteCommit) {
    return { ...base, error: `origin has no branch "${state.branch}".` }
  }
  if (remoteCommit === state.sourceCommit) {
    return { ...base, remoteCommit }
  }
  // The commit differs, which is not the same as being behind: a checkout with
  // local commits on top is AHEAD, and offering it an update would propose
  // undoing them. It is behind only when origin's commit is one it does not
  // already contain.
  let has = false
  try {
    await runGit(['-C', dir, 'merge-base', '--is-ancestor', remoteCommit, 'HEAD'])
    has = true
  } catch {
    has = false
  }
  return { ...base, remoteCommit, behind: !has }
}

export async function pullLocalExtensionImpl(extensionId: string): Promise<LocalPullResult> {
  const slug = slugFromId(extensionId)
  const dir = path.join(localExtRoot(), slug)
  // Re-read rather than trust what the page was showing: the tree may have
  // been dirtied since it asked, and this is the check that actually decides.
  const state = await readCheckoutState(dir)
  const blocked = blockedReason(state.branch, state.sourceDirty, state.sourceDirtyPaths)
  if (blocked) {
    throw new Error(`Refusing to update ${extensionId}. ${blocked}`)
  }
  const branch = state.branch as string
  const url = await remoteUrl(dir)
  if (!url) {
    throw new Error(`${extensionId} has no remote to update from.`)
  }
  const creds = await credentialsFor(dir)
  const { url: authedUrl, env, cleanup } = await withGitAuth(url, creds)
  try {
    await runGit(['-C', dir, 'fetch', authedUrl, branch], { maxBuffer: 64 * 1024 * 1024, env: gitEnvFor(env) })
  } finally {
    await cleanup()
  }
  const before = state.sourceCommit
  // Fast-forward only. A merge commit written by a background update is work
  // nobody asked for and nobody is watching; a checkout that has diverged is a
  // decision for whoever diverged it.
  await runGit(['-C', dir, 'merge', '--ff-only', 'FETCH_HEAD'])
  const { stdout: head } = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
  const after = head.trim()
  const moved = before !== after

  if (moved && before) {
    // Only when the pull actually touched them: npm install on every update
    // would spend a minute to discover it had nothing to do.
    const { stdout: changed } = await runGit(['-C', dir, 'diff', '--name-only', `${before}..${after}`])
    const paths = changed.split('\n').map((line) => line.trim())
    if (paths.includes('package.json') || paths.includes('package-lock.json')) {
      await installNodeDeps(dir)
    }
  }

  // The bundle this instance is running still comes from the old commit until
  // this happens, so the update is not finished without it. A build that fails
  // is reported rather than thrown: the files have already moved, and saying
  // "update failed" about a checkout that did update is worse than saying what
  // the compiler said.
  const build = await compileLocalExtensionImpl(extensionId)
  const record = await getLocalExtensionImpl(extensionId)
  if (!record) {
    throw new Error(`Failed to read ${extensionId} after updating it.`)
  }
  return { record, from: before, to: after, moved, build }
}
