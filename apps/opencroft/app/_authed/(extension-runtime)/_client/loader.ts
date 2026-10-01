'use client'

import {
  type ExtensionDeclaration,
  installClientHost,
  type LoadedExtensionDeclaration,
} from '@/app/_authed/(extension-runtime)/_client/host'
import { loadedDeclaration } from '@/app/_authed/(extension-runtime)/_client/loaded-declaration'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { extensionUrlBase } from '@/app/_authed/(extension-runtime)/_extension-id'
import { listExtensionManifests } from '@/app/_authed/(extension-runtime)/_server/actions'
import type { ExtensionManifest, ExtensionManifestInfo } from '@/app/_authed/(extension-runtime)/_types'

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
// override a host variant such as `sm:flex-row` arriving on a shared `@ext/ui`
// component. Inserting first is what prevents that, and nothing else does.
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

// Fetches and validates a bundle WITHOUT registering it, so several can be in
// flight at once while registration order stays under the caller's control.
async function importExtension(
  manifest: ExtensionManifest & { folder: string },
  clientVersion?: number,
): Promise<LoadedExtensionDeclaration | null> {
  installClientHost()
  const version = bundleVersion(clientVersion)
  injectStyles(manifest.id, version)
  try {
    const mod = await importBundle(bundleUrl(manifest.id, 'client.js', version))
    const decl = mod.default ?? mod.extension
    if (!decl?.manifest) {
      console.error(`[ext] ${manifest.id}: bundle default export is not a valid ExtensionDeclaration`)
      return null
    }
    return loadedDeclaration(decl, { id: manifest.id, folder: manifest.folder })
  } catch (err) {
    console.error(`[ext] ${manifest.id}: load failed`, err)
    return null
  }
}

export async function loadExtension(
  manifest: ExtensionManifest & { folder: string },
  clientVersion?: number,
): Promise<LoadedExtensionDeclaration | null> {
  const decl = await importExtension(manifest, clientVersion)
  if (decl) {
    extensionRegistry.register(decl)
  }
  return decl
}

export async function loadAllExtensions(): Promise<LoadedExtensionDeclaration[]> {
  const manifests: ExtensionManifestInfo[] = await listExtensionManifests()
  const withClient = manifests.filter((manifest) => manifest.hasClient)
  // Imported concurrently: the previous serial loop paid one round trip per
  // extension, back to back. `injectStyles` still runs in manifest order —
  // each call happens synchronously before its first await — so the cascade
  // order of the extension stylesheets is unaffected.
  const declarations = await Promise.all(
    withClient.map((manifest) => importExtension(manifest, manifest.clientVersion)),
  )
  const loaded = declarations.filter((decl): decl is LoadedExtensionDeclaration => decl !== null)
  for (const decl of loaded) {
    extensionRegistry.register(decl)
  }
  return loaded
}
