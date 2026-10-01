import type { CompileRefusal, CompileRefusalReason } from '../_types'
import { runGit } from './git-exec'

/** The name of the parameter a caller passes to compile a checkout anyway. */
export const COMPILE_OVERRIDE_PARAM = 'allowUnclean'

/** One entry of `git status --porcelain` output. */
export interface StatusEntry {
  /** The two-character status code, e.g. "??", " M", "A ". */
  code: string
  /** The path git reported, with a rename resolved to its destination. */
  path: string
}

/**
 * Parse `git status --porcelain` (v1) output into entries.
 *
 * Paths git considers to contain special characters arrive C-quoted. The
 * surrounding quotes are stripped, but the escapes inside are deliberately NOT
 * decoded: the paths are only listed back to a reader, and decoding would mean
 * maintaining a second copy of git's escaping rules for that.
 */
export function parseStatusLines(porcelain: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const raw of porcelain.split('\n')) {
    if (raw.trim().length === 0 || raw.length < 4) {
      continue
    }
    let value = raw.slice(3)
    // A rename/copy is reported as "ORIG -> DEST". The destination is what now
    // sits in the tree, so it is what gets classified.
    const arrow = value.indexOf(' -> ')
    if (arrow !== -1) {
      value = value.slice(arrow + 4)
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    entries.push({ code: raw.slice(0, 2), path: value })
  }
  return entries
}

export interface CheckoutState {
  /** The commit the checkout is on, or null when it is not a git checkout. */
  sourceCommit: string | null
  /**
   * True when the tree carries uncommitted changes, null when unknown. Every
   * change counts: the host writes nothing into an extension's tree outside
   * `dist/` and `node_modules/`, which extension repositories ignore.
   */
  sourceDirty: boolean | null
  /** The uncommitted paths behind `sourceDirty`. */
  sourceDirtyPaths: string[]
  /** The checked-out branch, "HEAD" when detached, or null when unknown. */
  branch: string | null
  /** The branch the remote calls default, or null when it cannot be determined. */
  defaultBranch: string | null
}

const UNKNOWN_CHECKOUT: CheckoutState = {
  sourceCommit: null,
  sourceDirty: null,
  sourceDirtyPaths: [],
  branch: null,
  defaultBranch: null,
}

/**
 * What a remote calls its default branch, or null when nothing says: a remote
 * whose HEAD was never recorded, no remote at all, or a directory that is not a
 * clone.
 *
 * Null means UNKNOWN, and every caller has to read it as "no opinion" rather
 * than as a mismatch — refusing to build a directory git can say nothing about
 * would break the plain case of an extension folder that was never a checkout.
 */
async function readDefaultBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['-C', dir, 'rev-parse', '--abbrev-ref', 'origin/HEAD'])
    const value = stdout.trim()
    if (!value) {
      return null
    }
    return value.startsWith('origin/') ? value.slice('origin/'.length) : value
  } catch {
    return null
  }
}

/**
 * Read what a checkout is: its commit, whether anyone has authored changes in
 * it, and which branch it is on.
 *
 * Read straight from the directory rather than tracked by this application,
 * so it stays true through anything that changes the tree — a plain checkout or
 * pull, not only this application's own actions. A directory that is not a git
 * checkout degrades to "unknown" rather than raising: being one has never been
 * a requirement.
 */
export async function readCheckoutState(dir: string): Promise<CheckoutState> {
  try {
    const { stdout: head } = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const { stdout: status } = await runGit(['-C', dir, 'status', '--porcelain'])
    const { stdout: branch } = await runGit(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const sourcePaths = parseStatusLines(status).map((entry) => entry.path)
    return {
      sourceCommit: head.trim(),
      sourceDirty: sourcePaths.length > 0,
      sourceDirtyPaths: sourcePaths,
      branch: branch.trim() || null,
      defaultBranch: await readDefaultBranch(dir),
    }
  } catch {
    return { ...UNKNOWN_CHECKOUT }
  }
}

const MAX_LISTED_PATHS = 5

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ')
  const rest = paths.length - MAX_LISTED_PATHS
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

/**
 * Whether a checkout in this state may be published to the running instance,
 * and if not, why.
 *
 * Compiling replaces what the instance is running, so it publishes whatever the
 * directory happens to hold at that moment. Two states are refused because both
 * publish something nobody asked for: a tree carrying changes someone has not
 * committed, and a tree parked on a branch other than the default one.
 *
 * Anything unknown is never a refusal. A directory git cannot describe, or a
 * remote with no recorded default branch, keeps building exactly as before —
 * a guard that fires on the absence of information would block work it knows
 * nothing about.
 *
 * The result is ADVISORY in the same sense as everything else guarding these
 * directories: `override` always gets through, because a deliberate build of a
 * branch on a throwaway instance is legitimate and must not need a workaround.
 */
export function refuseCompile(state: CheckoutState, override: boolean): CompileRefusal | null {
  if (override) {
    return null
  }
  const reasons: CompileRefusalReason[] = []
  const clauses: string[] = []

  if (state.sourceDirty === true) {
    reasons.push('unclean')
    clauses.push(`it carries uncommitted changes (${listPaths(state.sourceDirtyPaths)})`)
  }
  if (state.branch && state.defaultBranch && state.branch !== state.defaultBranch) {
    reasons.push('off-branch')
    clauses.push(`it is on branch "${state.branch}", not the default branch "${state.defaultBranch}"`)
  }
  if (reasons.length === 0) {
    return null
  }
  return {
    reasons,
    branch: state.branch,
    defaultBranch: state.defaultBranch,
    dirtyPaths: state.sourceDirtyPaths,
    message:
      `Refusing to compile: ${clauses.join(', and ')}. ` +
      `Compiling publishes this directory to the running instance as it stands. ` +
      `Pass ${COMPILE_OVERRIDE_PARAM}: true to compile it anyway.`,
  }
}
