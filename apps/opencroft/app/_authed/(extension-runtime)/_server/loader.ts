import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type * as opencroft from '@opencroft/server'

import {
  buildExtension,
  CLIENT_ENTRY_CANDIDATES,
  SERVER_ENTRY_CANDIDATES,
} from '@/app/_authed/(extension-runtime)/_server/compiler'
import { listAllExtensionIds, MANIFEST_FILE } from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import { createHost } from '@/app/_authed/(extension-runtime)/_server/host'
import { readManifest } from '@/app/_authed/(extension-runtime)/_server/manifest'
import { CLIENT_ICONS_FILE, extDir, extDistFile } from '@/app/_authed/(extension-runtime)/_server/paths'
import { sourceMtime, statMaybe } from '@/app/_authed/(extension-runtime)/_server/source-mtime'
import type { ExposeOutputFn, ExtensionManifest, ExtensionRoute } from '@/app/_authed/(extension-runtime)/_types'
import { toastStore } from '@/lib/toast-store'

export type NodeActionHandler = (ctx: unknown) => Promise<unknown>

type ExtensionLifecycle = (context: opencroft.ExtensionContext) => void | Promise<void>

export type ExtensionToolHandlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>

export type ActionAccess = 'signed-in' | 'admin'

interface CachedModule {
  updatedAt: number
  manifest: ExtensionManifest
  actions: Record<string, (...args: unknown[]) => Promise<unknown>>
  /** Per-action authorization policy declared by the extension alongside `actions`; an action it does not list is 'signed-in'. */
  actionAccess?: Record<string, ActionAccess>
  exposeOutput?: ExposeOutputFn
  /** Keyed by the extension's own bare node type, then action id. */
  nodeActions?: Record<string, Record<string, NodeActionHandler>>
  /** Per-node-action authorization policy, keyed like `nodeActions`, declared alongside it; an action it does not list is 'signed-in'. */
  nodeActionAccess?: Record<string, Record<string, ActionAccess>>
  routes?: Record<string, ExtensionRoute>
  tools?: ExtensionToolHandlers
  /** Per-App server lifecycle hooks, keyed by the App's bare type — see `AppsExport` in `@opencroft/server`. */
  apps?: opencroft.AppsExport
  load?: ExtensionLifecycle
  unload?: ExtensionLifecycle
  context: opencroft.ExtensionContext
  registeredTypes: opencroft.Type[]
  registeredNodes: opencroft.Node[]
}

interface ExtensionRegistrations {
  context: opencroft.ExtensionContext
  types: opencroft.Type[]
  nodes: opencroft.Node[]
}

function createRegistrations(extensionId: string): ExtensionRegistrations {
  const types: opencroft.Type[] = []
  const nodes: opencroft.Node[] = []
  const context: opencroft.ExtensionContext = {
    extensionId,
    registerType: (type) => {
      types.push(type)
    },
    registerNode: (node) => {
      nodes.push(node)
    },
  }
  return { context, types, nodes }
}

declare global {
  var __EXT_MODULE_CACHE__: Map<string, CachedModule> | undefined

  var __EXT_MANIFEST_CACHE__: Map<string, ExtensionManifest> | undefined
}

function moduleCache(): Map<string, CachedModule> {
  if (!globalThis.__EXT_MODULE_CACHE__) {
    globalThis.__EXT_MODULE_CACHE__ = new Map()
  }
  return globalThis.__EXT_MODULE_CACHE__
}

function manifestCache(): Map<string, ExtensionManifest> {
  if (!globalThis.__EXT_MANIFEST_CACHE__) {
    globalThis.__EXT_MANIFEST_CACHE__ = new Map()
  }
  return globalThis.__EXT_MANIFEST_CACHE__
}

async function ensureBuilt(extensionId: string, manifest: ExtensionManifest): Promise<void> {
  const srcMtime = await sourceMtime(extensionId)
  const serverMtime = await statMaybe(extDistFile(extensionId, 'server.js'))
  const clientMtime = await statMaybe(extDistFile(extensionId, 'client.js'))

  // Freshness is judged over the bundles this extension CAN have — the sides
  // with an entry point. The compiler writes nothing for a side without one, so
  // requiring both bundles (a missing file stats as 0, and min() then never
  // clears the "is built at all" bar) made every one-sided extension
  // permanently stale: rebuilt on every consultation, forever, with each
  // rebuild's staging directory then read as an uncommitted change by whichever
  // consultation overlapped it.
  const expectedMtimes: number[] = []
  if (manifest.main || (await hasEntry(extensionId, SERVER_ENTRY_CANDIDATES))) {
    expectedMtimes.push(serverMtime)
  }
  // Every client build records its icon names beside the bundle. A bundle
  // without that record predates it, and so also carries its own copy of
  // lucide-react: it is rebuilt like a stale one, and still served as the
  // fallback below if the rebuild fails.
  let iconsRecorded = true
  if (await hasEntry(extensionId, CLIENT_ENTRY_CANDIDATES)) {
    expectedMtimes.push(clientMtime)
    iconsRecorded = (await statMaybe(extDistFile(extensionId, CLIENT_ICONS_FILE))) > 0
  }
  // No entry on either side: a build would emit no bundle, so there is no
  // staleness to measure and nothing to publish.
  if (expectedMtimes.length === 0) {
    return
  }
  const bundleMtime = Math.min(...expectedMtimes)
  if (bundleMtime > 0 && bundleMtime >= srcMtime && iconsRecorded) {
    unbuildable.delete(extensionId)
    return
  }
  // Every expected side has a (possibly stale) bundle on disk — the fallback
  // a failed build keeps serving rather than leaving nothing.
  const hasExistingBundle = expectedMtimes.every((mtime) => mtime > 0)

  // Consulted on every page load, so an outcome that cannot change until its
  // inputs do is not attempted, nor announced to everyone, again.
  const remembered = unbuildable.get(extensionId)
  if (remembered && Date.now() < remembered.retryAt && remembered.srcMtime === srcMtime) {
    if (hasExistingBundle) {
      return
    }
    throw new Error(remembered.message)
  }

  const result = await buildExtension(extensionId, manifest)
  if (!result.success) {
    const summary = result.errors.map((e) => `${e.file}:${e.line ?? '?'}  ${e.message}`).join('\n')
    toastStore.broadcast({
      type: 'toast',
      toastType: 'error',
      message: `${extensionId} build failed:\n${summary}`,
    })
    const message = `Extension ${extensionId} failed to build:\n${summary}`
    unbuildable.set(extensionId, { srcMtime, message, retryAt: Date.now() + FAILED_BUILD_RETRY_MS })
    if (hasExistingBundle) {
      console.error(`[ext] ${extensionId} rebuild failed, keeping previous bundle:\n${summary}`)
      return
    }
    throw new Error(message)
  }
  unbuildable.delete(extensionId)
}

/**
 * An auto-rebuild that failed. It stands while the sources it read are
 * unchanged, up to `retryAt`.
 */
interface Unbuildable {
  srcMtime: number
  message: string
  retryAt: number
}

const unbuildable = new Map<string, Unbuildable>()

// A build can fail for a reason outside the sources, such as a dependency
// install that hit the network or timed out, so a failure is kept only this
// long before it is attempted once more.
const FAILED_BUILD_RETRY_MS = 5 * 60 * 1000

interface ExtensionServerModule {
  actions?: Record<string, (...args: unknown[]) => Promise<unknown>>
  actionAccess?: Record<string, ActionAccess>
  exposeOutput?: ExposeOutputFn
  nodeActions?: Record<string, Record<string, NodeActionHandler>>
  nodeActionAccess?: Record<string, Record<string, ActionAccess>>
  routes?: Record<string, ExtensionRoute>
  tools?: ExtensionToolHandlers
  apps?: opencroft.AppsExport
  load?: ExtensionLifecycle
  unload?: ExtensionLifecycle
  default?: {
    actions?: Record<string, (...args: unknown[]) => Promise<unknown>>
    actionAccess?: Record<string, ActionAccess>
    exposeOutput?: ExposeOutputFn
    nodeActions?: Record<string, Record<string, NodeActionHandler>>
    nodeActionAccess?: Record<string, Record<string, ActionAccess>>
    routes?: Record<string, ExtensionRoute>
    tools?: ExtensionToolHandlers
    apps?: opencroft.AppsExport
    load?: ExtensionLifecycle
    unload?: ExtensionLifecycle
  }
}

async function evalServerBundle(extensionId: string, manifest: ExtensionManifest): Promise<CachedModule> {
  const bundleFile = extDistFile(extensionId, 'server.js')
  let code: string
  const reg = createRegistrations(extensionId)
  try {
    code = await fs.readFile(bundleFile, 'utf-8')
  } catch {
    return {
      updatedAt: Date.now(),
      manifest,
      actions: {},
      context: reg.context,
      registeredTypes: reg.types,
      registeredNodes: reg.nodes,
    }
  }

  const host = createHost(extensionId)
  const prevGlobal = (globalThis as { __extensionServerApi?: unknown }).__extensionServerApi
  ;(globalThis as { __extensionServerApi?: unknown }).__extensionServerApi = { host }
  try {
    const mod: { exports: ExtensionServerModule } = { exports: {} }
    // Resolve the extension's own dependencies (sharp, ffmpeg-static, …) from
    // its own node_modules; fall back to the app for host-provided externals
    // (ssh2, node built-ins).
    const extRequire = createRequire(bundleFile)
    const appRequire: NodeRequire = createRequire(import.meta.url)
    const runtimeRequire = ((id: string) => {
      try {
        return extRequire(id)
      } catch {
        return appRequire(id)
      }
    }) as NodeRequire
    runtimeRequire.resolve = ((id: string) => {
      try {
        return extRequire.resolve(id)
      } catch {
        return appRequire.resolve(id)
      }
    }) as NodeRequire['resolve']
    const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', code)
    fn(mod, mod.exports, runtimeRequire, extDir(extensionId), bundleFile)

    const exported = mod.exports
    const actions = exported.actions ?? exported.default?.actions ?? {}
    const actionAccess = exported.actionAccess ?? exported.default?.actionAccess ?? {}
    const exposeOutput = exported.exposeOutput ?? exported.default?.exposeOutput
    const nodeActions = exported.nodeActions ?? exported.default?.nodeActions
    const nodeActionAccess = exported.nodeActionAccess ?? exported.default?.nodeActionAccess ?? {}
    const routes = exported.routes ?? exported.default?.routes
    const tools = exported.tools ?? exported.default?.tools
    const apps = exported.apps ?? exported.default?.apps
    const load = exported.load ?? exported.default?.load
    const unload = exported.unload ?? exported.default?.unload
    return {
      updatedAt: Date.now(),
      manifest,
      actions,
      actionAccess,
      exposeOutput,
      nodeActions,
      nodeActionAccess,
      routes,
      tools,
      apps,
      load,
      unload,
      context: reg.context,
      registeredTypes: reg.types,
      registeredNodes: reg.nodes,
    }
  } finally {
    ;(globalThis as { __extensionServerApi?: unknown }).__extensionServerApi = prevGlobal
  }
}

async function activate(extensionId: string): Promise<CachedModule> {
  const manifest = await readManifest(extensionId)
  manifestCache().set(extensionId, manifest)

  for (const dep of manifest.extensionDependencies ?? []) {
    await activate(dep)
  }

  await ensureBuilt(extensionId, manifest)
  const mod = await evalServerBundle(extensionId, manifest)
  moduleCache().set(extensionId, mod)
  await mod.load?.(mod.context)
  return mod
}

// Two callers racing the staleness check below (`await sourceMtime`) can each
// independently decide reactivation is needed and each call `activate()` --
// reproduced live (two requests 5ms apart after one solitary compile were
// enough) and root-caused as the mechanism behind the bug: two module
// instances both `load()`, one is discarded, and whichever request lands
// against the loser sees whatever it managed to initialize before losing.
//
// Single-flight per extensionId closes it: the whole check-then-act body
// below runs under one lock, so a second caller waits on the SAME promise
// instead of starting its own. The lock is taken synchronously (no `await`
// between the map lookup and the map set), so two calls that race at the
// JS level can never both see "no lock" -- one of them always wins first.
const getModuleLocks = new Map<string, Promise<CachedModule>>()

export function getExtensionModule(extensionId: string): Promise<CachedModule> {
  const inFlight = getModuleLocks.get(extensionId)
  if (inFlight) {
    return inFlight
  }
  const promise = getExtensionModuleExclusive(extensionId).finally(() => {
    if (getModuleLocks.get(extensionId) === promise) {
      getModuleLocks.delete(extensionId)
    }
  })
  getModuleLocks.set(extensionId, promise)
  return promise
}

async function getExtensionModuleExclusive(extensionId: string): Promise<CachedModule> {
  const cached = moduleCache().get(extensionId)
  if (cached) {
    const srcMtime = await sourceMtime(extensionId)
    if (srcMtime <= cached.updatedAt) {
      return cached
    }
    runUnload(extensionId)
  }
  return activate(extensionId)
}

async function manifestMtime(extensionId: string): Promise<number> {
  return statMaybe(path.join(extDir(extensionId), MANIFEST_FILE))
}

const manifestMtimeCache = new Map<string, number>()

export async function getManifest(extensionId: string): Promise<ExtensionManifest> {
  const mtime = await manifestMtime(extensionId)
  const cached = manifestCache().get(extensionId)
  if (cached && manifestMtimeCache.get(extensionId) === mtime) {
    return cached
  }
  const manifest = await readManifest(extensionId)
  manifestCache().set(extensionId, manifest)
  manifestMtimeCache.set(extensionId, mtime)
  return manifest
}

export async function loadAllManifests(): Promise<ExtensionManifest[]> {
  const ids = await listAllExtensionIds()
  const manifests: ExtensionManifest[] = []
  for (const id of ids) {
    try {
      manifests.push(await getManifest(id))
    } catch (err) {
      console.error(`[ext] failed to read manifest for ${id}`, err)
    }
  }
  return manifests
}

const LIFECYCLE_ENTRIES = ['extension.ts', 'extension.tsx']

async function hasEntry(extensionId: string, names: string[]): Promise<boolean> {
  const dir = extDir(extensionId)
  for (const name of names) {
    if ((await statMaybe(path.join(dir, name))) > 0) {
      return true
    }
  }
  return false
}

/** Whether the extension ships a client bundle the browser should import. */
export async function extensionHasClient(extensionId: string): Promise<boolean> {
  return hasEntry(extensionId, CLIENT_ENTRY_CANDIDATES)
}

/** Activate every extension that exposes a lifecycle entry, so its `load` runs. */
export async function activateLifecycleExtensions(): Promise<void> {
  const ids = await listAllExtensionIds()
  for (const id of ids) {
    if (!(await hasEntry(id, LIFECYCLE_ENTRIES))) {
      continue
    }
    try {
      await getExtensionModule(id)
    } catch (err) {
      console.error(`[ext] ${id} activation failed`, err)
    }
  }
}

export async function ensureExtensionBuilt(extensionId: string): Promise<void> {
  const manifest = await readManifest(extensionId)
  await ensureBuilt(extensionId, manifest)
}

// Identity of the built client artifacts, used to version their URLs so they
// can be cached immutably instead of re-downloaded on every load.
//
// Deliberately the BUILT files' mtime, not the source's: it is the artifact
// being cached, and `ensureBuilt` keeps serving an existing bundle whenever it
// is newer than the source, so this is exactly what a request would return —
// a cache entry can never disagree with what the server would hand back.
// Both files are produced by one build and versioned together.
//
// 0 when nothing is built yet; the caller substitutes a unique value so that
// first request misses the cache and triggers the build.
//
// ASSUMES artifacts are built at runtime on the instance, so these are real
// filesystem times and two builds cannot share one. Shipping prebuilt `dist/`
// with normalized timestamps (a container layer, a tar with fixed mtimes)
// would break that: two different builds could collide on one version, and an
// immutably-cached bundle would then be pinned for a year. Switch this to a
// content hash of the artifacts if that day comes.
//
// A version identifies the artifact as of the request, not its content: a
// rebuild landing between the listing and the fetch caches the new bundle
// under the old version. Harmless — the next listing carries the new version
// and refetches — but it is not a content address, so don't treat it as one.
export async function clientBundleVersion(extensionId: string): Promise<number> {
  const js = await statMaybe(extDistFile(extensionId, 'client.js'))
  const css = await statMaybe(extDistFile(extensionId, 'client.css'))
  return Math.max(js, css)
}

/** The icon names the last client build found in the extension's sources; none before a build. */
export async function clientIconNames(extensionId: string): Promise<string[]> {
  const text = await fs.readFile(extDistFile(extensionId, CLIENT_ICONS_FILE), 'utf-8').catch(() => '[]')
  try {
    const names: unknown = JSON.parse(text)
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

function runUnload(extensionId: string): void {
  const mod = moduleCache().get(extensionId)
  if (!mod?.unload) {
    return
  }
  void mod.unload(mod.context)
}

export function flushCache(extensionId?: string): void {
  if (extensionId) {
    runUnload(extensionId)
    moduleCache().delete(extensionId)
    manifestCache().delete(extensionId)
    manifestMtimeCache.delete(extensionId)
    unbuildable.delete(extensionId)
    return
  }
  for (const id of moduleCache().keys()) {
    runUnload(id)
  }
  moduleCache().clear()
  manifestCache().clear()
  manifestMtimeCache.clear()
  unbuildable.clear()
}
