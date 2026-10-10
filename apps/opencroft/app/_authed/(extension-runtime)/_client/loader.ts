'use client'

import { preloadIcons } from 'ui/media/named-icon'

import { clientsProviding, clientsWithSettingsPages } from '@/app/_authed/(extension-runtime)/_client/bundles-to-load'
import type { ExtensionDeclaration, LoadedExtensionDeclaration } from '@/app/_authed/(extension-runtime)/_client/host'
import { loadedDeclaration } from '@/app/_authed/(extension-runtime)/_client/loaded-declaration'
import { providerRegistry } from '@/app/_authed/(extension-runtime)/_client/provides'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { declaredIconNames } from '@/app/_authed/(extension-runtime)/_declared-icons'
import { extensionUrlBase } from '@/app/_authed/(extension-runtime)/_extension-id'
import { listExtensionClients } from '@/app/_authed/(extension-runtime)/_server/actions'
import type { ExtensionClientInfo } from '@/app/_authed/(extension-runtime)/_types'

interface LoadedModule {
  default?: ExtensionDeclaration
  extension?: ExtensionDeclaration
}

// Versioned by the built artifact's identity, which the server serves
// immutably — an unchanged extension is then taken from the browser cache
// instead of re-downloaded, and a rebuilt one arrives under a new URL. A
// caller with no version (the extension editor, reloading its own rebuild)
// gets a unique one, so it always refetches.
function bundleVersion(clientVersion?: number): number {
  return clientVersion && clientVersion > 0 ? clientVersion : Date.now()
}

function bundleUrl(extensionId: string, file: string, version: number): string {
  return `${extensionUrlBase(extensionId)}/${file}?v=${version}`
}

// The host API the bundles bind to reaches most of the app's client code, so it
// is fetched when extensions are loaded rather than with the pages that only
// might load them. Every page imports this module for the shell's extension
// surfaces; a static import here would make all of the host part of every
// page's first load. A failed fetch is not kept, so the next load asks again.
let hostInstalled: Promise<void> | null = null

function installHost(): Promise<void> {
  hostInstalled ??= import('@/app/_authed/(extension-runtime)/_client/host').then(
    ({ installClientHost }) => installClientHost(),
    (err: unknown) => {
      hostInstalled = null
      throw err
    },
  )
  return hostInstalled
}

async function importBundle(url: string): Promise<LoadedModule> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<LoadedModule>
}

// Each extension ships a runtime-compiled stylesheet (utilities for the
// classes its client code uses, referencing the host theme). Inserted BEFORE
// the host styles, and this is still load-bearing — but for less than it used
// to be, so it is worth being exact about which half.
//
// An extension's PLAIN utilities share the host's `utilities` layer, so order
// alone separates them: loaded after the host, an extension's `.hidden` would
// override a host variant such as `sm:flex-row` arriving on a shared kit
// component (`@opencroft/client/ui`). Inserting first is what prevents that, and nothing else does.
//
// Its VARIANT utilities no longer depend on this. They are emitted into a
// later cascade layer (see _server/css-cascade-layers.ts), which outranks
// everything in `utilities` whichever sheet the browser parses first — the
// order used to decide that too, and decided it wrongly.
//
// So: moving this insertion later reintroduces a real defect, and moving it
// earlier changes nothing. It is not a free knob in either direction.
function injectStyles(extensionId: string, version: number): void {
  const href = bundleUrl(extensionId, 'client.css', version)
  const id = `ext-css-${extensionId}`
  const existing = document.getElementById(id)
  if (existing instanceof HTMLLinkElement) {
    existing.href = href
    return
  }
  const link = document.createElement('link')
  link.id = id
  link.rel = 'stylesheet'
  link.href = href
  const hostStyles = document.head.querySelector('link[rel="stylesheet"]:not([id^="ext-css-"]), style')
  document.head.insertBefore(link, hostStyles)
}

type LoadableExtension = Pick<ExtensionClientInfo, 'id' | 'folder'> & Partial<Pick<ExtensionClientInfo, 'clientIcons'>>

// Fetches and validates a bundle WITHOUT registering it, so several can be in
// flight at once while registration order stays under the caller's control.
//
// The icons the extension names -- in its sources, and in what it declares --
// are loaded before it is handed back, so that nothing it renders, and nothing
// the host renders for it, draws an icon that is still on its way.
async function importExtension(
  manifest: LoadableExtension,
  clientVersion?: number,
): Promise<LoadedExtensionDeclaration | null> {
  const version = bundleVersion(clientVersion)
  injectStyles(manifest.id, version)
  try {
    await installHost()
    const [mod] = await Promise.all([
      importBundle(bundleUrl(manifest.id, 'client.js', version)),
      preloadIcons(manifest.clientIcons ?? []),
    ])
    const decl = mod.default ?? mod.extension
    if (!decl?.manifest) {
      console.error(`[ext] ${manifest.id}: bundle default export is not a valid ExtensionDeclaration`)
      return null
    }
    const loaded = loadedDeclaration(decl, { id: manifest.id, folder: manifest.folder })
    await preloadIcons(declaredIconNames(loaded))
    return loaded
  } catch (err) {
    console.error(`[ext] ${manifest.id}: load failed`, err)
    return null
  }
}

export async function loadExtension(
  manifest: LoadableExtension,
  clientVersion?: number,
): Promise<LoadedExtensionDeclaration | null> {
  const decl = await importExtension(manifest, clientVersion)
  if (decl) {
    extensionRegistry.register(decl)
  }
  return decl
}

// One listing serves every load that starts while it is on its way, so a page
// mounting several extension surfaces at once asks once. It also fixes the
// order provided entries are shown in, whichever extensions load first.
let listing: Promise<ExtensionClientInfo[]> | null = null

function listClients(): Promise<ExtensionClientInfo[]> {
  listing ??= listExtensionClients()
    .then((clients) => {
      providerRegistry.setOrder(clients.map((client) => client.id))
      return clients
    })
    .finally(() => {
      listing = null
    })
  return listing
}

// Each listed build is imported once per page, however many surfaces ask for
// it. A failed import is not kept, so the next load tries again.
const imports = new Map<string, Promise<LoadedExtensionDeclaration | null>>()

function importOnce(client: ExtensionClientInfo): Promise<LoadedExtensionDeclaration | null> {
  const key = `${client.id}@${client.clientVersion}`
  let pending = imports.get(key)
  if (!pending) {
    pending = importExtension(client, client.clientVersion).then((decl) => {
      if (!decl) {
        imports.delete(key)
      }
      return decl
    })
    imports.set(key, pending)
  }
  return pending
}

// The server reads what a bundle declares off the bundle itself (see
// _server/provided-points.ts). A point or settings page it registers outside
// that reading is missing wherever only the listing loads the bundle, so it is
// reported rather than left to be noticed as an absent panel.
function reportUnlistedPoints(client: ExtensionClientInfo, decl: LoadedExtensionDeclaration): void {
  const listed = client.providedPoints
  const unlisted = listed ? Object.keys(decl.provides ?? {}).filter((point) => !listed.includes(point)) : []
  if (client.hasSettingsPages === false && (decl.settings ?? []).length > 0) {
    unlisted.push('settings pages')
  }
  if (unlisted.length > 0) {
    console.error(
      `[ext] ${client.id}: registers ${unlisted.join(', ')}, which its listing does not name, so it can be missing where only that is shown`,
    )
  }
}

async function loadClients(clients: ExtensionClientInfo[]): Promise<LoadedExtensionDeclaration[]> {
  // Imported concurrently. `injectStyles` still runs in listing order — each
  // call happens synchronously before its first await — so the cascade order
  // of the extension stylesheets is unaffected.
  const declarations = await Promise.all(clients.map(importOnce))
  const loaded: LoadedExtensionDeclaration[] = []
  declarations.forEach((decl, index) => {
    if (decl) {
      reportUnlistedPoints(clients[index], decl)
      extensionRegistry.register(decl)
      loaded.push(decl)
    }
  })
  return loaded
}

/** Every extension, for the surfaces that show any of them: the canvas. */
export async function loadAllExtensions(): Promise<LoadedExtensionDeclaration[]> {
  // Started beside the listing rather than after it: every bundle waits for the
  // host. A failure here is reported by each import that awaits it.
  installHost().catch(() => {})
  return loadClients(await listClients())
}

/**
 * The extensions whose bundles provide `point`, and every one whose points
 * are not known. Nothing else is fetched, the host included: a page whose
 * point nobody provides loads no extension code.
 */
export async function loadExtensionsProviding(point: string): Promise<LoadedExtensionDeclaration[]> {
  const clients = await listClients()
  return loadClients(clientsProviding(clients, point))
}

/** The extensions that declare settings pages, and every one not known: the settings menu's. */
export async function loadExtensionsWithSettingsPages(): Promise<LoadedExtensionDeclaration[]> {
  return loadClients(clientsWithSettingsPages(await listClients()))
}

// Asked once per page: an extension with no client bundle is never listed, and
// asking again would only repeat the listing. A listing or a load that fails
// is forgotten, so the next ref that needs the extension asks again.
const askedFor = new Set<string>()

/** The extension `extensionId`, when something outside the canvas shows one of its node types. */
export async function loadExtensionById(extensionId: string): Promise<void> {
  if (extensionRegistry.getById(extensionId) || askedFor.has(extensionId)) {
    return
  }
  askedFor.add(extensionId)
  let loaded = false
  try {
    const listed = (await listClients()).filter((client) => client.id === extensionId)
    loaded = (await loadClients(listed)).length === listed.length
  } finally {
    if (!loaded) {
      askedFor.delete(extensionId)
    }
  }
}
