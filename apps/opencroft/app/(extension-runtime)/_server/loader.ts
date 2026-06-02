import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { buildExtension } from '@/app/(extension-runtime)/_server/compiler'
import { createHost } from '@/app/(extension-runtime)/_server/host'
import { listAllExtensionIds, readManifest } from '@/app/(extension-runtime)/_server/manifest'
import { extDir, extDistFile } from '@/app/(extension-runtime)/_server/paths'
import type { ExtensionManifest, ExtensionRouteHandler } from '@/app/(extension-runtime)/_types'
import { toastStore } from '@/lib/toast-store'

export type NodeActionHandler = (ctx: unknown) => Promise<unknown>

interface CachedModule {
  updatedAt: number
  manifest: ExtensionManifest
  actions: Record<string, (...args: unknown[]) => Promise<unknown>>
  exposeOutput?: (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown
  nodeActions?: Record<string, Record<string, NodeActionHandler>>
  routes?: Record<string, ExtensionRouteHandler>
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

async function sourceMtime(extensionId: string): Promise<number> {
  const dir = extDir(extensionId)
  const candidates = [path.join(dir, 'extension.json'), path.join(dir, 'package.json'), path.join(dir, 'src'), path.join(dir, 'server')]
  let max = 0
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
  const serverBundle = extDistFile(extensionId, 'server.js')
  const clientBundle = extDistFile(extensionId, 'client.js')
  const srcMtime = await sourceMtime(extensionId)
  const serverMtime = await statMaybe(serverBundle)
  const clientMtime = await statMaybe(clientBundle)
  const bundleMtime = Math.min(serverMtime, clientMtime)
  if (bundleMtime > 0 && bundleMtime >= srcMtime) {
    return
  }
  const result = await buildExtension(extensionId, manifest)
  if (!result.success) {
    const summary = result.errors.map((e) => `${e.file}:${e.line ?? '?'}  ${e.message}`).join('\n')
    toastStore.broadcast({
      type: 'toast',
      toastType: 'error',
      message: `${extensionId} build failed:\n${summary}`,
    })
    const hasExistingBundle = serverMtime > 0 && clientMtime > 0
    if (hasExistingBundle) {
      console.error(`[ext] ${extensionId} rebuild failed, keeping previous bundle:\n${summary}`)
      return
    }
    throw new Error(`Extension ${extensionId} failed to build:\n${summary}`)
  }
}

interface ExtensionServerModule {
  actions?: Record<string, (...args: unknown[]) => Promise<unknown>>
  exposeOutput?: (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown
  nodeActions?: Record<string, Record<string, NodeActionHandler>>
  routes?: Record<string, ExtensionRouteHandler>
  default?: {
    actions?: Record<string, (...args: unknown[]) => Promise<unknown>>
    exposeOutput?: (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown
    nodeActions?: Record<string, Record<string, NodeActionHandler>>
    routes?: Record<string, ExtensionRouteHandler>
  }
}

async function evalServerBundle(extensionId: string, manifest: ExtensionManifest): Promise<CachedModule> {
  const bundleFile = extDistFile(extensionId, 'server.js')
  let code: string
  try {
    code = await fs.readFile(bundleFile, 'utf-8')
  } catch {
    return { updatedAt: Date.now(), manifest, actions: {} }
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
    const exposeOutput = exported.exposeOutput ?? exported.default?.exposeOutput
    const nodeActions = exported.nodeActions ?? exported.default?.nodeActions
    const routes = exported.routes ?? exported.default?.routes
    return { updatedAt: Date.now(), manifest, actions, exposeOutput, nodeActions, routes }
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
  return mod
}

export async function getExtensionModule(extensionId: string): Promise<CachedModule> {
  const cached = moduleCache().get(extensionId)
  if (cached) {
    const srcMtime = await sourceMtime(extensionId)
    if (srcMtime <= cached.updatedAt) {
      return cached
    }
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

export async function ensureExtensionBuilt(extensionId: string): Promise<void> {
  const manifest = await readManifest(extensionId)
  await ensureBuilt(extensionId, manifest)
}

export function flushCache(extensionId?: string): void {
  if (extensionId) {
    moduleCache().delete(extensionId)
    manifestCache().delete(extensionId)
    manifestMtimeCache.delete(extensionId)
    return
  }
  moduleCache().clear()
  manifestCache().clear()
  manifestMtimeCache.clear()
}
