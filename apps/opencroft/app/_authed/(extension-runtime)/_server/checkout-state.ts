import { promises as fs } from 'node:fs'

import { runGit } from './git-exec'

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
 * than as a mismatch.
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
 * Whether `dir` is the root of its own repository.
 *
 * git run inside a folder that has no repository of its own walks up to the
 * nearest enclosing one and answers for THAT: an extension folder created
 * inside the application's checkout would report the application's commit,
 * branch and uncommitted files as its own.
 */
async function isOwnRepositoryRoot(dir: string): Promise<boolean> {
  const { stdout } = await runGit(['-C', dir, 'rev-parse', '--show-toplevel'])
  // git prints the top level with symlinks resolved, so the folder is resolved
  // the same way before the two are compared.
  return stdout.trim() === (await fs.realpath(dir))
}

/**
 * Read what a checkout is: its commit, whether anyone has authored changes in
 * it, and which branch it is on.
 *
 * Read straight from the directory rather than tracked by this application,
 * so it stays true through anything that changes the tree — a plain checkout or
 * pull, not only this application's own actions. A directory that is not the
 * root of its own git checkout degrades to "unknown" rather than raising: being
 * one has never been a requirement.
 */
export async function readCheckoutState(dir: string): Promise<CheckoutState> {
  try {
    if (!(await isOwnRepositoryRoot(dir))) {
      return { ...UNKNOWN_CHECKOUT }
    }
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
