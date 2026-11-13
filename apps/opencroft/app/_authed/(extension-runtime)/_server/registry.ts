import { promises as fs } from 'node:fs'
import path from 'node:path'

import { readEnv } from '@opencroft/instance'

import type { InstallAuth } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import {
  credentialProblem,
  listStoredRegistries,
  type RegistryInput,
  repositoryProblem,
  storedRegistryAuth,
} from '@/app/_authed/(extension-runtime)/_server/registry-settings'
import { resolveAuth as resolveInstallAuth } from '@/app/_authed/(extension-runtime)/_server/source-repository'
import { remoteFailure, runGit, withGitAuth } from './git-exec'

// ── Types ──────────────────────────────────────────────────────────

export interface RegistryExtension {
  /** `<owner>.<extension>`: the extension id it installs as, and its folder. Already two slugs. */
  id: string
  name: string
  description?: string
  repository: string
  /**
   * The branch of `repository` an install from this entry follows, instead of
   * the latest version tag. An update then moves it to that branch's newest commit.
   */
  branch?: string
  author?: string
  homepage?: string
  tags?: string[]
}

export interface RegistryManifest {
  extensions: RegistryExtension[]
}

/** Where a registry is configured: always there, OPENCROFT_EXTENSION_REGISTRIES, or Settings. */
export type RegistryOrigin = 'default' | 'environment' | 'settings'

export interface RegistrySource {
  /** Display name for the registry */
  name: string
  /** Git URL or owner/repo shorthand */
  url: string
  origin: RegistryOrigin
  /** The stored registry's id, for one added in Settings. */
  id?: string
  /** The Secrets Store keys it signs in with, the same an install from it records. */
  auth?: InstallAuth
  /** Inline username from env (e.g. user:token@owner/repo) */
  username?: string
  /** Inline token from env */
  token?: string
  /** Optional ref (branch/tag), defaults to HEAD/main */
  ref?: string
}

export interface ResolvedRegistry {
  source: RegistrySource
  manifest: RegistryManifest
  fetchedAt: number
}

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_REGISTRY = 'opencroft/registry'

interface ParsedRegistryEntry {
  name: string
  url: string
  username?: string
  token?: string
  authStoreId?: string
}

/**
 * Parse a single OPENCROFT_EXTENSION_REGISTRIES entry.
 * Supports inline credentials:
 *   token@owner/repo
 *   user:token@owner/repo
 *   https://user:token@domain.com/org/repo
 *   store:nodeId@owner/repo
 */
function parseRegistryEntry(entry: string): ParsedRegistryEntry {
  // Check for secret store ref: store:nodeId@owner/repo
  const storeMatch = entry.match(/^store:([\w-]+)@(.+)$/)
  if (storeMatch) {
    const [, storeId, repo] = storeMatch
    return { name: repo, url: repo, authStoreId: storeId }
  }

  // Check for shorthand with credentials: [user:]token@owner/repo
  const shorthandMatch = entry.match(/^(?:(\w[\w.-]*)?:)?(\S+?)@([\w.-]+\/[\w.-]+)$/)
  if (shorthandMatch) {
    const [, user, token, repo] = shorthandMatch
    return {
      name: repo,
      url: repo,
      username: user || 'x-access-token',
      token,
    }
  }

  // Check for full URL with credentials
  try {
    const parsed = new URL(entry)
    if (parsed.username || parsed.password) {
      // Detect store:nodeId pattern embedded in URL: https://store:nodeId@host/...
      if (parsed.username === 'store') {
        return {
          name: parsed.pathname
            .replace(/^\/+/, '')
            .replace(/\.git$/, '')
            .replace(/\/+$/, ''),
          url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
          authStoreId: decodeURIComponent(parsed.password),
        }
      }
      // Regular inline credentials
      const url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      return {
        name: parsed.pathname
          .replace(/^\/+/, '')
          .replace(/\.git$/, '')
          .replace(/\/+$/, ''),
        url,
        username: decodeURIComponent(parsed.username) || undefined,
        token: decodeURIComponent(parsed.password) || undefined,
      }
    }
  } catch {
    // Not a valid URL, treat as shorthand without auth
  }

  return { name: entry, url: entry }
}

function parseRegistriesEnv(): RegistrySource[] {
  const raw = readEnv('OPENCROFT_EXTENSION_REGISTRIES')?.trim()
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parsed = parseRegistryEntry(entry)
      return {
        name: parsed.name,
        url: parsed.url,
        origin: 'environment' as const,
        username: parsed.username,
        token: parsed.token,
        ...(parsed.authStoreId ? { auth: { type: 'secret' as const, storeId: parsed.authStoreId } } : {}),
      }
    })
}

/** What two registry addresses are compared by: `owner/repo` and its GitHub URL are one registry. */
export function registryKey(url: string): string {
  return resolveGitUrl(url).toLowerCase()
}

/**
 * Every registry, in the order a lookup reads them: the default, then the
 * environment's, then the ones added in Settings. A registry named twice is
 * read once, where it comes first.
 */
export async function getRegistrySources(): Promise<RegistrySource[]> {
  const stored = (await listStoredRegistries()).map(
    (registry): RegistrySource => ({
      name: registry.repository,
      url: registry.repository,
      origin: 'settings',
      id: registry.id,
      auth: storedRegistryAuth(registry),
    }),
  )
  const sources: RegistrySource[] = []
  const seen = new Set<string>()
  for (const source of [
    { name: 'OpenCroft', url: DEFAULT_REGISTRY, origin: 'default' as const },
    ...parseRegistriesEnv(),
    ...stored,
  ]) {
    const key = registryKey(source.url)
    if (!seen.has(key)) {
      seen.add(key)
      sources.push(source)
    }
  }
  return sources
}

/**
 * Why a registry can't be stored as given, or undefined: its repository, its
 * credential picks, or a registry already listed at the same address. `input.id`
 * is the stored registry being edited, which may keep its own address.
 */
export async function storedRegistryProblem(input: RegistryInput): Promise<string | undefined> {
  const problem = repositoryProblem(input.repository) ?? (await credentialProblem(input))
  if (problem) {
    return problem
  }
  const key = registryKey(input.repository)
  const taken = (await getRegistrySources()).find(
    (source) => registryKey(source.url) === key && !(source.origin === 'settings' && source.id === input.id),
  )
  if (taken) {
    const where = {
      default: 'is the default registry',
      environment: 'comes from the environment',
      settings: 'is listed',
    }
    return `${input.repository} ${where[taken.origin]} already.`
  }
  return undefined
}

// ── Auth ────────────────────────────────────────────────────────────

async function resolveAuth(source: RegistrySource): Promise<{ username: string; token: string } | null> {
  // Inline credentials from env take priority
  if (source.token) {
    return { username: source.username ?? 'x-access-token', token: source.token }
  }
  // The same resolution an install from this registry runs, so the two sign in alike.
  return resolveInstallAuth(source.auth)
}

// ── URL Resolution ──────────────────────────────────────────────────

function resolveGitUrl(input: string): string {
  const trimmed = input.trim().replace(/\.git\/?$/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`
  }
  if (!trimmed.endsWith('.git')) {
    return `${trimmed}.git`
  }
  return trimmed
}

function rawFileUrl(gitUrl: string, filePath: string, ref?: string): string {
  const clean = gitUrl.replace(/\.git$/, '')
  const refBranch = ref ?? 'main'

  if (clean.includes('github.com')) {
    const parts = clean.replace('https://github.com/', '')
    return `https://raw.githubusercontent.com/${parts}/${refBranch}/${filePath}`
  }

  // Generic Forgejo/Gitea
  return `${clean}/raw/branch/${refBranch}/${filePath}`
}

// ── Registry Cache ──────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CachedRegistry {
  registry: ResolvedRegistry
  expiresAt: number
}

declare global {
  var __REGISTRY_CACHE__: Map<string, CachedRegistry> | undefined
}

function registryCache(): Map<string, CachedRegistry> {
  if (!globalThis.__REGISTRY_CACHE__) {
    globalThis.__REGISTRY_CACHE__ = new Map()
  }
  return globalThis.__REGISTRY_CACHE__
}

// ── Fetching ────────────────────────────────────────────────────────

async function fetchRegistryManifest(source: RegistrySource): Promise<ResolvedRegistry> {
  const gitUrl = resolveGitUrl(source.url)
  const creds = await resolveAuth(source)

  // Try raw file fetch first (faster, no clone needed)
  const rawUrl = rawFileUrl(gitUrl, 'registry.json', source.ref)

  let manifestJson: string
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (creds) {
      const basic = Buffer.from(`${creds.username}:${creds.token}`).toString('base64')
      headers.Authorization = `Basic ${basic}`
    }

    const response = await fetch(rawUrl, { headers, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    manifestJson = await response.text()
  } catch {
    // Fallback: git clone
    const tmpDir = path.join(process.cwd(), '.cache', 'registry-tmp', `reg-${Date.now()}`)
    const { url: authedUrl, env, cleanup } = await withGitAuth(gitUrl, creds)
    try {
      await fs.mkdir(tmpDir, { recursive: true })
      const cloneArgs = source.ref
        ? ['clone', '--depth', '1', '--branch', source.ref, '--single-branch', authedUrl, tmpDir]
        : ['clone', '--depth', '1', authedUrl, tmpDir]
      await runGit(cloneArgs, { maxBuffer: 4 * 1024 * 1024, env }).catch((err) => {
        throw remoteFailure(err, gitUrl)
      })
      manifestJson = await fs.readFile(path.join(tmpDir, 'registry.json'), 'utf-8').catch(() => {
        throw new Error('The repository has no registry.json at its root.')
      })
    } finally {
      await cleanup()
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  let parsed: RegistryManifest
  try {
    parsed = JSON.parse(manifestJson) as RegistryManifest
  } catch {
    throw new Error('registry.json is not valid JSON.')
  }
  if (!Array.isArray(parsed?.extensions)) {
    throw new Error(`Invalid registry.json: missing "extensions" array`)
  }

  return {
    source,
    manifest: parsed,
    fetchedAt: Date.now(),
  }
}

// ── Public API ──────────────────────────────────────────────────────

/** One registry as a read of it went: its listing (a stale one when the read failed), or why there is none. */
export interface RegistryOutcome {
  source: RegistrySource
  registry?: ResolvedRegistry
  /** Why the latest read failed, in a sentence that names no credential. */
  error?: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function loadRegistries(forceRefresh = false): Promise<RegistryOutcome[]> {
  const cache = registryCache()
  const outcomes: RegistryOutcome[] = []

  for (const source of await getRegistrySources()) {
    const cacheKey = source.url
    const cached = cache.get(cacheKey)

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      outcomes.push({ source, registry: cached.registry })
      continue
    }

    try {
      const registry = await fetchRegistryManifest(source)
      cache.set(cacheKey, { registry, expiresAt: Date.now() + CACHE_TTL_MS })
      outcomes.push({ source, registry })
    } catch (err) {
      console.error(`[registry] Failed to fetch ${source.url}:`, errorText(err))
      // Return stale cache if available
      outcomes.push({ source, ...(cached ? { registry: cached.registry } : {}), error: errorText(err) })
    }
  }

  return outcomes
}

export async function fetchAllRegistries(forceRefresh = false): Promise<ResolvedRegistry[]> {
  return (await loadRegistries(forceRefresh)).flatMap((outcome) => (outcome.registry ? [outcome.registry] : []))
}

/**
 * Read a registry as it would be stored, without storing or caching it: how
 * many extensions it lists, or why it can't be read.
 */
export async function checkRegistry(input: RegistryInput): Promise<{ extensions: number } | { error: string }> {
  const problem = repositoryProblem(input.repository) ?? (await credentialProblem(input))
  if (problem) {
    return { error: problem }
  }
  try {
    const { manifest } = await fetchRegistryManifest({
      name: input.repository,
      url: input.repository,
      origin: 'settings',
      auth: storedRegistryAuth({ ...input, id: input.id ?? '' }),
    })
    return { extensions: manifest.extensions.length }
  } catch (err) {
    return { error: errorText(err) }
  }
}

export async function searchRegistries(query?: string): Promise<(RegistryExtension & { registryName: string })[]> {
  const registries = await fetchAllRegistries()
  const all: (RegistryExtension & { registryName: string })[] = []

  const q = query?.toLowerCase()?.trim()

  for (const reg of registries) {
    for (const ext of reg.manifest.extensions) {
      if (!q) {
        all.push({ ...ext, registryName: reg.source.name })
        continue
      }
      const searchable = [ext.name, ext.description ?? '', ext.author ?? '', ...(ext.tags ?? [])]
        .join(' ')
        .toLowerCase()
      if (searchable.includes(q)) {
        all.push({ ...ext, registryName: reg.source.name })
      }
    }
  }

  return all
}

export function clearRegistryCache(): void {
  registryCache().clear()
}

// ── Lookup ──────────────────────────────────────────────────────────

export interface ExtensionSpec {
  /** The extension id, e.g. "acme.my-extension". */
  id: string
  /** Optional version/ref to pin */
  version?: string
}

/**
 * Parse the OPENCROFT_EXTENSIONS env var, the extensions installed at boot:
 * "acme.extension-a:1.0.0,author.extension-b"
 */
export function parseExtensionsEnv(): ExtensionSpec[] {
  const raw = readEnv('OPENCROFT_EXTENSIONS')?.trim()
  if (!raw) {
    return []
  }

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, version] = entry.split(':')
      return { id: id.trim(), version: version?.trim() || undefined }
    })
}

/**
 * The first registry entry with this extension id, with the registry it came
 * from and that registry's credentials, which the extension's repository
 * reuses. Ids may repeat across registries; the first registry wins. An entry
 * whose `branch` is not a non-empty string is refused rather than installed at
 * a tag it did not ask for.
 */
export async function findRegistryExtension(
  extensionId: string,
): Promise<{ repository: string; branch?: string; registryName: string; auth?: InstallAuth } | null> {
  const registries = await fetchAllRegistries()
  for (const reg of registries) {
    for (const ext of reg.manifest.extensions) {
      if (ext.id !== extensionId) {
        continue
      }
      const branch: unknown = ext.branch
      if (branch !== undefined && (typeof branch !== 'string' || !branch.trim())) {
        throw new Error(
          `Registry ${reg.source.name} lists ${extensionId} with an invalid branch: ${JSON.stringify(branch)}`,
        )
      }
      return {
        repository: ext.repository,
        ...(branch ? { branch: branch.trim() } : {}),
        registryName: reg.source.name,
        auth: reg.source.auth,
      }
    }
  }
  return null
}
