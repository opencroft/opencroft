// Installing, updating and removing extension folders.
//
// An install never touches the live folder until the replacement is complete:
// the source is fetched into a staging folder beside it, its dependencies are
// installed and it is built there, and only then is it renamed into place and
// its row written. A failure before the swap leaves the live folder and its row
// as they were, and removes the staging folder. A process killed mid-install
// can leave a staging or a displaced folder behind; `sweepInstallDebris` puts
// that right at startup, before any extension loads.
//
// Nothing here writes into an extension's sources: its manifest is read, never
// rewritten, and where it came from is recorded in the extension table.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  isBuiltinFolder,
  isReservedOwner,
  localFolderFor,
  parseExtensionId,
  slugifyPart,
} from '@/app/_authed/(extension-runtime)/_extension-id'
import { buildExtensionAt } from '@/app/_authed/(extension-runtime)/_server/compiler'
import {
  extensionIdOf,
  isInstallableFolder,
  MANIFEST_FILE,
  scanExtensionFolders,
} from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import {
  authOf,
  deleteExtensionRow,
  type ExtensionRow,
  getExtensionRow,
  type InstallAuth,
  writeExtensionRow,
} from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import { flushCache } from '@/app/_authed/(extension-runtime)/_server/loader'
import { normalizeManifest } from '@/app/_authed/(extension-runtime)/_server/manifest'
import { extensionsRoot, folderDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import { findRegistryExtension, parseExtensionsEnv } from '@/app/_authed/(extension-runtime)/_server/registry'
import {
  fetchSource,
  listRemoteTags,
  parseRepoUrl,
  resolveAuth,
  type SourceRequest,
} from '@/app/_authed/(extension-runtime)/_server/source-repository'
import { toastStore } from '@/lib/toast-store'

export interface InstallRequest extends SourceRequest {
  /** The folder under `extensions/` the extension is installed into. */
  folder: string
  /** The registry the repository was found through, by name. */
  registryName?: string
  auth?: InstallAuth
}

let scratchCount = 0

function scratchDir(kind: 'staging' | 'old', folder: string): string {
  scratchCount += 1
  return path.join(extensionsRoot(), `.${kind}-${folder}-${process.pid}-${scratchCount}`)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

// A folder's installs, updates and removals run one at a time.
const folderQueues = new Map<string, Promise<unknown>>()

function serialized<T>(folder: string, work: () => Promise<T>): Promise<T> {
  const previous = folderQueues.get(folder) ?? Promise.resolve()
  const next = previous.then(work, work)
  folderQueues.set(folder, next)
  void next
    .finally(() => {
      if (folderQueues.get(folder) === next) {
        folderQueues.delete(folder)
      }
    })
    .catch(() => {})
  return next
}

function describeSource(row: ExtensionRow | null): string {
  if (!row?.sourceUrl) {
    return ''
  }
  return row.registryName ? ` from ${row.sourceUrl} (registry ${row.registryName})` : ` from ${row.sourceUrl}`
}

/**
 * Install an extension into a new folder, or with `update` replace the folder's
 * contents with a fresh fetch of its source. A new install into a folder that
 * already exists is refused, naming where the existing one came from: nothing
 * is overwritten and nothing is suffixed.
 */
export function installExtension(request: InstallRequest, { update = false } = {}): Promise<ExtensionRow> {
  return serialized(request.folder, () => installNow(request, update))
}

async function installNow(request: InstallRequest, update: boolean): Promise<ExtensionRow> {
  const { folder } = request
  if (!isInstallableFolder(folder, { local: request.asLocal })) {
    throw new Error(
      request.asLocal
        ? `A development checkout goes into a local.<name> folder, not "${folder}"`
        : `"${folder}" is not an installable extension id: two slugs, <owner>.<extension>, and not a builtin or local owner`,
    )
  }
  if (update && request.asLocal) {
    throw new Error(`${folder} is a development checkout: it is updated by pulling, which keeps its commits`)
  }
  const live = folderDir(folder)
  const present = await exists(live)
  if (!update && present) {
    throw new Error(`${folder} is already installed${describeSource(await getExtensionRow(folder))}`)
  }
  if (update && !present) {
    throw new Error(`${folder} is not installed`)
  }

  const creds = await resolveAuth(request.auth)
  const staging = scratchDir('staging', folder)
  let extensionId: string
  let row: ExtensionRow
  try {
    await fs.mkdir(extensionsRoot(), { recursive: true })
    const fetched = await fetchSource(request, creds, staging)
    const declared = JSON.parse(await fs.readFile(path.join(staging, MANIFEST_FILE), 'utf-8')) as { id?: unknown }
    const id = extensionIdOf(folder, declared.id)
    if ('error' in id) {
      throw new Error(`${folder}: ${id.error}`)
    }
    extensionId = id.extensionId
    const manifest = normalizeManifest(declared as Parameters<typeof normalizeManifest>[0], extensionId)
    const build = await buildExtensionAt(
      { extensionId, sourceDir: staging, distDir: path.join(staging, 'dist') },
      manifest,
    )
    if (!build.success) {
      const summary = build.errors.map((e) => `${e.file}:${e.line ?? '?'}  ${e.message}`).join('\n')
      throw new Error(`${folder} did not build:\n${summary}`)
    }
    row = await swapIntoPlace(folder, staging, {
      url: request.url,
      registryName: request.registryName,
      auth: request.auth,
      ref: fetched.ref,
      commit: fetched.commit,
    })
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  flushCache(extensionId)
  await scanExtensionFolders()
  toastStore.broadcast({ type: 'extensions_updated' })
  return row
}

/**
 * Put a finished staging folder in place of the live one and record it. The
 * live folder is moved aside rather than deleted until the row is written, so
 * a failed row write can move it back.
 */
async function swapIntoPlace(
  folder: string,
  staging: string,
  source: Parameters<typeof writeExtensionRow>[1],
): Promise<ExtensionRow> {
  const live = folderDir(folder)
  const displaced = (await exists(live)) ? scratchDir('old', folder) : null
  if (displaced) {
    await fs.rename(live, displaced)
  }
  let placed = false
  try {
    await fs.rename(staging, live)
    placed = true
    const row = await writeExtensionRow(folder, source)
    if (displaced) {
      await fs.rm(displaced, { recursive: true, force: true })
    }
    return row
  } catch (error) {
    if (placed) {
      await fs.rename(live, staging)
    }
    if (displaced) {
      await fs.rename(displaced, live)
    }
    throw error
  }
}

/**
 * Remove an extension folder, then its row. A folder that is already gone
 * counts as removed. If the folder cannot be removed the row stays, so the
 * extension is still known and the removal can be retried. Nodes, graphs, app
 * instances and their data are not touched.
 */
export function uninstallExtension(folder: string): Promise<void> {
  if (isBuiltinFolder(folder)) {
    return Promise.reject(new Error(`${folder} is part of the app and cannot be removed`))
  }
  return serialized(folder, async () => {
    const entries = await scanExtensionFolders()
    const extensionId = entries.find((entry) => entry.folder === folder)?.extensionId ?? folder
    await fs.rm(folderDir(folder), { recursive: true, force: true })
    await deleteExtensionRow(folder)
    flushCache(extensionId)
    await scanExtensionFolders()
    toastStore.broadcast({ type: 'extensions_updated' })
  })
}

// ── Entry points ────────────────────────────────────────────────────

/**
 * Install the extension a registry lists under `extensionId`: into the folder
 * of that id, or with `asLocal` as a development checkout in `local.<extension>`,
 * which then stands in for it.
 */
export async function installFromRegistry(
  extensionId: string,
  options: { ref?: string; asLocal?: boolean } = {},
): Promise<ExtensionRow> {
  const parsed = parseExtensionId(extensionId)
  if (!parsed) {
    throw new Error(`"${extensionId}" is not an extension id (<owner>.<extension>)`)
  }
  const listed = await findRegistryExtension(extensionId)
  if (!listed) {
    throw new Error(`Extension "${extensionId}" not found in any registry`)
  }
  const asLocal = options.asLocal === true
  return installExtension({
    folder: asLocal ? localFolderFor(parsed.extension) : extensionId,
    url: listed.repository,
    registryName: listed.registryName,
    auth: listed.auth,
    ref: options.ref,
    asLocal,
  })
}

/**
 * The folder a URL install goes into. An explicit `id` is used as given (two
 * slugs, not a reserved owner). Otherwise it is `<owner>.<repo>` from a path of
 * exactly two segments, each slugified on its own; a longer path (nested
 * groups) needs the id spelled out rather than having its owner guessed. A
 * development checkout goes into `local.<repo>`.
 */
export function folderForUrl(input: string, options: { id?: string; asLocal?: boolean } = {}): string {
  const { segments } = parseRepoUrl(input)
  if (options.asLocal) {
    const repo = slugifyPart(segments.at(-1) ?? '')
    if (!repo) {
      throw new Error(`Cannot take a repository name from ${input}`)
    }
    return localFolderFor(repo)
  }
  if (options.id) {
    const parsed = parseExtensionId(options.id)
    if (!parsed || isReservedOwner(parsed.owner)) {
      throw new Error(`"${options.id}" is not an installable extension id: two slugs, not a builtin or local owner`)
    }
    return options.id
  }
  if (segments.length !== 2) {
    throw new Error(`${input} does not name exactly <owner>/<repo>; give the extension id to install it under`)
  }
  const [owner, repo] = segments.map(slugifyPart)
  if (!owner || !repo) {
    throw new Error(`Cannot take an extension id from ${input}; give one to install it under`)
  }
  return `${owner}.${repo}`
}

export function installFromUrl(input: {
  url: string
  id?: string
  ref?: string
  auth?: InstallAuth
  asLocal?: boolean
}): Promise<ExtensionRow> {
  const asLocal = input.asLocal === true
  return installExtension({
    folder: folderForUrl(input.url, { id: input.id, asLocal }),
    url: parseRepoUrl(input.url).url,
    auth: input.auth,
    ref: input.ref,
    asLocal,
  })
}

async function sourceRow(folder: string): Promise<ExtensionRow & { sourceUrl: string }> {
  const row = await getExtensionRow(folder)
  if (!row?.sourceUrl) {
    throw new Error(`${folder} was not installed from a repository, so there is nothing to update it from`)
  }
  return row as ExtensionRow & { sourceUrl: string }
}

/** Reinstall a folder from the source it was installed from, at `ref` or its newest version. */
export async function updateExtension(folder: string, ref?: string): Promise<ExtensionRow> {
  const row = await sourceRow(folder)
  return installExtension(
    {
      folder,
      url: row.sourceUrl,
      registryName: row.registryName ?? undefined,
      auth: authOf(row),
      ref,
      asLocal: false,
    },
    { update: true },
  )
}

export interface UpdateCheck {
  current: string | null
  latest: string | null
  hasUpdate: boolean
  availableTags: string[]
}

/** The versions a folder's source offers, newest first, against the one installed. */
export async function checkForUpdates(folder: string): Promise<UpdateCheck> {
  const row = await sourceRow(folder)
  const tags = (await listRemoteTags(row.sourceUrl, await resolveAuth(authOf(row)))).reverse()
  const latest = tags[0] ?? null
  return { current: row.ref, latest, hasUpdate: latest !== null && row.ref !== latest, availableTags: tags }
}

/**
 * Install the extensions the EXTENSIONS env var lists, at boot: each one not yet
 * installed, and each one pinned to a version it is not at. Logs, never throws.
 */
export async function autoInstallExtensions(): Promise<void> {
  const specs = parseExtensionsEnv()
  if (specs.length === 0) {
    return
  }
  console.log(`[extensions] auto-install: ${specs.length} extension(s) to check`)
  for (const spec of specs) {
    try {
      const row = await getExtensionRow(spec.id)
      if (!row || !(await exists(folderDir(spec.id)))) {
        console.log(`[extensions] auto-install: installing ${spec.id}${spec.version ? `@${spec.version}` : ''}`)
        await installFromRegistry(spec.id, { ref: spec.version })
      } else if (spec.version && row.ref !== spec.version) {
        console.log(`[extensions] auto-install: updating ${spec.id} to ${spec.version}`)
        await updateExtension(spec.id, spec.version)
      }
    } catch (err) {
      console.error(`[extensions] auto-install: failed to install ${spec.id}:`, err)
    }
  }
}

// ── Crash recovery ──────────────────────────────────────────────────

const STAGING = /^\.staging-(.+)-\d+-\d+$/
const DISPLACED = /^\.old-(.+)-\d+-\d+$/

/**
 * Clean up after installs a killed process left half done: a staging folder is
 * deleted; a displaced folder goes back into place when its folder is missing
 * (the kill came between the two renames), and is deleted otherwise. Run at
 * startup, before any extension loads.
 */
export async function sweepInstallDebris(): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(extensionsRoot())
  } catch {
    return
  }
  for (const name of names) {
    const full = path.join(extensionsRoot(), name)
    if (STAGING.test(name)) {
      await fs.rm(full, { recursive: true, force: true })
      continue
    }
    const displaced = name.match(DISPLACED)
    if (displaced) {
      const live = folderDir(displaced[1])
      if (await exists(live)) {
        await fs.rm(full, { recursive: true, force: true })
      } else {
        await fs.rename(full, live)
      }
    }
  }
}
