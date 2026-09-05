import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type * as opencroft from '@opencroft/server'

import { readCheckoutState, refuseCompile } from '@/app/_authed/(extension-runtime)/_server/checkout-state'
import {
  buildExtension,
  CLIENT_ENTRY_CANDIDATES,
  SERVER_ENTRY_CANDIDATES,
} from '@/app/_authed/(extension-runtime)/_server/compiler'
import { createHost } from '@/app/_authed/(extension-runtime)/_server/host'
import { listAllExtensionIds, readManifest } from '@/app/_authed/(extension-runtime)/_server/manifest'
import { extDir, extDistFile, projectRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionManifest, ExtensionRouteHandler } from '@/app/_authed/(extension-runtime)/_types'
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
  exposeOutput?: (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown
  nodeActions?: Record<string, Record<string, NodeActionHandler>>
  /** Per-node-action authorization policy, keyed typeId then actionId, declared alongside `nodeActions`; an action it does not list is 'signed-in'. */
  nodeActionAccess?: Record<string, Record<string, ActionAccess>>
  routes?: Record<string, ExtensionRouteHandler>
  tools?: ExtensionToolHandlers
  /** Per-App server lifecycle hooks, keyed by App slug — see `AppsExport` in `@opencroft/server`. */
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

async function statMaybe(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file)
    return stat.mtimeMs
  } catch {
    return 0
  }
}

// Extensions can import any workspace package (agent-client, agent-chat, …)
// via the monorepo's shared node_modules symlinks — esbuild resolves and
// bundles their TS source directly into the extension (see
// ALWAYS_BUNDLED_PACKAGES in compiler.ts; that list isn't exhaustive — any
// workspace package actually imported gets bundled the same way). A merge
// touching only packages/* never changes anything under an extension's own
// directory, so sourceMtime alone can't see it — walk every workspace
// package's source too. Conservative on purpose: any package change
// invalidates every extension's cache, even ones that don't import it,
// rather than risk missing one that does — the walk itself is cheap (a
// handful of top-level dirs, same cost class as walking one extension's src).
async function workspacePackagesMtime(): Promise<number> {
  const dir = path.join(projectRoot(), '..', '..', 'packages')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  let max = 0
  for (const entry of entries) {
    max = Math.max(max, await walkMtime(path.join(dir, entry, 'src')))
    max = Math.max(max, await statMaybe(path.join(dir, entry, 'package.json')))
  }
  return max
}

async function sourceMtime(extensionId: string): Promise<number> {
  const dir = extDir(extensionId)
  const candidates = [
    path.join(dir, 'extension.json'),
    path.join(dir, 'package.json'),
    path.join(dir, 'src'),
    path.join(dir, 'server'),
    path.join(dir, 'extension.ts'),
    path.join(dir, 'extension.tsx'),
  ]
  let max = await workspacePackagesMtime()
  for (const p of candidates) {
    max = Math.max(max, await walkMtime(p))
  }
  return max
}

async function walkMtime(start: string): Promise<number> {
  try {
    const stat = await fs.stat(start)
    if (stat.isFile()) {
      return stat.mtimeMs
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(start)
      let max = stat.mtimeMs
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') {
          continue
        }
        max = Math.max(max, await walkMtime(path.join(start, entry)))
      }
      return max
    }
    return 0
  } catch {
    return 0
  }
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
  if (await hasEntry(extensionId, CLIENT_ENTRY_CANDIDATES)) {
    expectedMtimes.push(clientMtime)
  }
  // No entry on either side: a build would emit no bundle, so there is no
  // staleness to measure and nothing to publish.
  if (expectedMtimes.length === 0) {
    return
  }
  const bundleMtime = Math.min(...expectedMtimes)
  if (bundleMtime > 0 && bundleMtime >= srcMtime) {
    return
  }
  // Every expected side has a (possibly stale) bundle on disk — the fallback
  // both the refusal and a failed build keep serving rather than leaving
  // nothing.
  const hasExistingBundle = expectedMtimes.every((mtime) => mtime > 0)

  // A rebuild here republishes whatever the registered checkout currently holds,
  // and this path fires on ANY write into it -- an edit, a `git checkout`, a
  // `git pull` -- with no explicit compile. `compile_extension` already refuses
  // to publish a tree that carries uncommitted changes or sits on a branch other
  // than its default; that refusal lived only on the manual door. The same check
  // here is what stops an unreviewed branch deploying itself on the next load,
  // which is exactly what the "never compile on the main instance" guidance was
  // wrongly assumed to prevent.
  //
  // No override on this path, deliberately: the manual door takes `allowUnclean`
  // because a person asked for that particular build. Nothing asked for this
  // one, so there is no intent to honour -- a deliberate build of a branch is
  // what `compile_extension` is for.
  //
  // Builtin extensions are exempt: they are compiled from the application's OWN
  // source tree, not from an independently registered checkout, so reading their
  // git state reads the app repo's -- dirty through all of development, and on
  // whatever branch the app itself is deployed from. That state says nothing
  // about an unreviewed extension parked in a dev checkout, which is the only
  // thing this refusal is about; a builtin simply tracks the app it ships in.
  const isRegisteredCheckout = extensionId.split('/')[0] !== 'builtin'
  const refusal = isRegisteredCheckout ? refuseCompile(await readCheckoutState(extDir(extensionId)), false) : null
  if (refusal) {
    // Loud in BOTH directions. A silent refusal only trades an unnoticed deploy
    // for an unnoticed stale bundle -- the same defect wearing the other coat --
    // so the reason is logged and toasted whether or not a previous bundle
    // survives to be served.
    console.error(`[ext] ${extensionId} auto-rebuild refused: ${refusal.message}`)
    toastStore.broadcast({
      type: 'toast',
      toastType: 'error',
      message: `${extensionId} was not rebuilt. ${refusal.message}`,
    })
    if (hasExistingBundle) {
      return
    }
    // Nothing built to fall back on, and this tree may not be published
    // automatically: fail loudly rather than silently building it anyway. Mirrors
    // the no-bundle branch of the build-failure handling just below.
    throw new Error(`Extension ${extensionId} was not built: ${refusal.message}`)
  }

  const result = await buildExtension(extensionId, manifest)
  if (!result.success) {
    const summary = result.errors.map((e) => `${e.file}:${e.line ?? '?'}  ${e.message}`).join('\n')
    toastStore.broadcast({
      type: 'toast',
      toastType: 'error',
      message: `${extensionId} build failed:\n${summary}`,
    })
    if (hasExistingBundle) {
      console.error(`[ext] ${extensionId} rebuild failed, keeping previous bundle:\n${summary}`)
      return
    }
    throw new Error(`Extension ${extensionId} failed to build:\n${summary}`)
  }
}

interface ExtensionServerModule {
  actions?: Record<string, (...args: unknown[]) => Promise<unknown>>
  actionAccess?: Record<string, ActionAccess>
  exposeOutput?: (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown
  nodeActions?: Record<string, Record<string, NodeActionHandler>>
  nodeActionAccess?: Record<string, Record<string, ActionAccess>>
  routes?: Record<string, ExtensionRouteHandler>
  tools?: ExtensionToolHandlers
  apps?: opencroft.AppsExport
  load?: ExtensionLifecycle
  unload?: ExtensionLifecycle
  default?: {
    actions?: Record<string, (...args: unknown[]) => Promise<unknown>>
    actionAccess?: Record<string, ActionAccess>
    exposeOutput?: (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown
    nodeActions?: Record<string, Record<string, NodeActionHandler>>
    nodeActionAccess?: Record<string, Record<string, ActionAccess>>
    routes?: Record<string, ExtensionRouteHandler>
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
  return statMaybe(path.join(extDir(extensionId), 'extension.json'))
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
    return
  }
  for (const id of moduleCache().keys()) {
    runUnload(id)
  }
  moduleCache().clear()
  manifestCache().clear()
  manifestMtimeCache.clear()
}
