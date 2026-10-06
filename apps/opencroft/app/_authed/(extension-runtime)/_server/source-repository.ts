// Reading an extension's source repository: the credential an install points
// at, the tags and branches it offers, and one commit of it fetched into a folder.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { InstallAuth } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import { remoteFailure, runGit, withGitAuth } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { getSecretValue } from '@/app/_authed/(secrets-store)/_server/actions'

const GIT_BUFFER = 64 * 1024 * 1024

export interface ResolvedAuth {
  username: string
  token: string
}

/** The credential an InstallAuth points at, or null for none. */
export async function resolveAuth(auth?: InstallAuth): Promise<ResolvedAuth | null> {
  if (!auth) {
    return null
  }
  const tokenKey = auth.tokenKey ?? 'token'
  const usernameKey = auth.usernameKey ?? 'username'
  const [token, username] = await Promise.all([
    getSecretValue({ data: { storeId: auth.storeId, key: tokenKey } }),
    getSecretValue({ data: { storeId: auth.storeId, key: usernameKey } }),
  ])
  if (!token) {
    throw new Error(`Secret ${auth.storeId}/${tokenKey} not found or empty`)
  }
  return { username: username ?? 'x-access-token', token }
}

export function semverCmp(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((p) => Number.parseInt(p, 10) || 0)
  const ax = norm(a)
  const bx = norm(b)
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const diff = (ax[i] ?? 0) - (bx[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

/** What a repository offers: its tags, oldest version first, and its branches with the commit each is at. */
export interface RemoteRefs {
  tags: string[]
  branches: Map<string, string>
}

export async function listRemoteRefs(url: string, creds: ResolvedAuth | null): Promise<RemoteRefs> {
  const { url: authedUrl, env, cleanup } = await withGitAuth(url, creds)
  let stdout: string
  try {
    ;({ stdout } = await runGit(['ls-remote', '--tags', '--heads', '--refs', authedUrl], {
      maxBuffer: 4 * 1024 * 1024,
      env,
    }))
  } catch (err) {
    throw remoteFailure(err, url)
  } finally {
    await cleanup()
  }
  const tags: string[] = []
  const branches = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const [commit, ref] = line.trim().split('\t')
    if (!commit || !ref) {
      continue
    }
    if (ref.startsWith('refs/tags/')) {
      tags.push(ref.slice('refs/tags/'.length))
    } else if (ref.startsWith('refs/heads/')) {
      branches.set(ref.slice('refs/heads/'.length), commit)
    }
  }
  return { tags: tags.sort(semverCmp), branches }
}

/**
 * The commit an install at `ref` moves to when it follows a branch, or null
 * when it does not: `ref` names a tag, or nothing the repository has. A name
 * that is both a tag and a branch is read as the tag.
 */
export function followedBranchTip(ref: string | null, refs: RemoteRefs): string | null {
  if (!ref || refs.tags.includes(ref)) {
    return null
  }
  return refs.branches.get(ref) ?? null
}

/** A repository URL or `owner/repo` shorthand, normalized, with its path segments. */
export function parseRepoUrl(input: string): { url: string; segments: string[] } {
  const trimmed = input.trim().replace(/\.git\/?$/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return { url: `https://github.com/${trimmed}.git`, segments: trimmed.split('/') }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid repository URL: ${input}`)
  }
  const cleaned = parsed.pathname.replace(/\/+$/, '')
  return { url: `${parsed.origin}${cleaned}.git`, segments: cleaned.split('/').filter(Boolean) }
}

export interface SourceRequest {
  /** The repository to fetch. */
  url: string
  /**
   * The tag or branch to fetch. Defaults to the highest version tag, or the
   * repository's default branch when it has none; for a development checkout,
   * to the default branch.
   */
  ref?: string
  /**
   * A development checkout: a full clone keeping `.git`, so it can be edited,
   * committed and pulled. Otherwise a snapshot of one commit without `.git`.
   */
  asLocal: boolean
}

async function defaultRef(url: string, creds: ResolvedAuth | null, asLocal: boolean): Promise<string | undefined> {
  if (asLocal) {
    return undefined
  }
  const { tags } = await listRemoteRefs(url, creds)
  return tags.at(-1)
}

/** Clone `ref` (or the default) into `dest`; returns the full sha and the ref actually checked out. */
export async function fetchSource(
  request: SourceRequest,
  creds: ResolvedAuth | null,
  dest: string,
): Promise<{ commit: string; ref: string }> {
  const ref = request.ref ?? (await defaultRef(request.url, creds, request.asLocal))
  const { url: authedUrl, env, cleanup } = await withGitAuth(request.url, creds)
  const shape = request.asLocal ? [] : ['--depth', '1']
  const branch = ref ? ['--branch', ref, '--single-branch'] : []
  try {
    await runGit(['clone', ...shape, ...branch, authedUrl, dest], { maxBuffer: GIT_BUFFER, env })
  } catch (err) {
    throw remoteFailure(err, request.url)
  } finally {
    await cleanup()
  }
  const { stdout: commit } = await runGit(['-C', dest, 'rev-parse', 'HEAD'])
  const { stdout: head } = await runGit(['-C', dest, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (!request.asLocal) {
    await fs.rm(path.join(dest, '.git'), { recursive: true, force: true })
  }
  return { commit: commit.trim(), ref: ref ?? head.trim() }
}
