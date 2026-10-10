// What a command runs over: which repository, which of its files, and which of
// them a task changed.
//
// Every list here comes from git rather than from walking the disk, so it is
// the same set a reviewer sees: tracked files plus untracked ones that are not
// ignored. Dependencies, build output and an instance's data directory never
// enter it, whatever the biome config says.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A fetch-shaped call must never stop to ask for a password: a prompt in a
    // non-interactive run is a hang, not a question.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

const tryGit = (cwd, args) => {
  try {
    return git(cwd, args).trim()
  } catch {
    return null
  }
}

const nulList = (out) => out.split('\0').filter(Boolean)

/** The repository the command was started in. */
export function repoRoot(cwd) {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!root) {
    throw new Error(`${cwd} is not inside a git checkout`)
  }
  return root
}

/** Files that exist on disk: a tracked file deleted in the working tree is
 *  still in the index, and biome refuses a path that is not there. */
const existing = (root, files) => files.filter((file) => existsSync(path.join(root, file)))

/** Every file of the repository: tracked, plus untracked and not ignored. */
export function allFiles(root) {
  const listed = nulList(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
  return existing(root, [...new Set(listed)].sort())
}

/**
 * The branch this checkout's work will merge into, as a remote ref.
 *
 * Asked of the remote rather than guessed from branch names: some repositories
 * integrate on `stage` and others on `main`, and one carries both with `main`
 * as its default, so "stage if it exists" would be wrong there. In order:
 * an explicit `--base`, the remote's recorded HEAD, the remote's HEAD asked
 * over the network, and last the branch this one was created from (a worktree
 * branched off `origin/<x>` tracks it until something re-points it).
 */
export function resolveBase(root, explicit) {
  if (explicit) {
    if (!tryGit(root, ['rev-parse', '--verify', '--quiet', `${explicit}^{commit}`])) {
      throw new Error(`--base ${explicit} does not name a commit here`)
    }
    return explicit
  }
  const recorded = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (recorded) {
    return recorded
  }
  const advertised = tryGit(root, ['ls-remote', '--symref', 'origin', 'HEAD'])
  const head = advertised?.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1]
  if (head && tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${head}`])) {
    return `origin/${head}`
  }
  const upstream = tryGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const branch = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (upstream?.startsWith('origin/') && upstream !== `origin/${branch}`) {
    return upstream
  }
  throw new Error(
    'could not tell which branch this checkout merges into (no origin/HEAD, no answer from origin, no upstream) — pass --base origin/<branch>',
  )
}

/**
 * Files this checkout changed against where it branched off: committed on the
 * branch, staged, unstaged, and new untracked files. Deleted files are left
 * out, there is nothing left to format.
 *
 * Measured from the merge-base, not from the base's tip, so work merged into
 * the base after the branch was cut does not count as this branch's change.
 */
export function changedFiles(root, base) {
  const mergeBase = tryGit(root, ['merge-base', 'HEAD', base])
  if (!mergeBase) {
    throw new Error(`${base} shares no history with HEAD`)
  }
  const changed = nulList(git(root, ['diff', '-z', '--name-only', '--no-renames', '--diff-filter=ACMRT', mergeBase]))
  const added = nulList(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))
  return { mergeBase, files: existing(root, [...new Set([...changed, ...added])].sort()) }
}

/** The commit a result was measured on, and whether the tree had moved past it. */
export function describeTree(root) {
  const sha = tryGit(root, ['rev-parse', 'HEAD'])
  if (!sha) {
    return 'unknown (not a git checkout)'
  }
  const dirty = (tryGit(root, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length
  return `${sha}${dirty === 0 ? ' (clean)' : ` (+${dirty} uncommitted)`}`
}
