'use client'

import { type ExtensionDeclaration, installClientHost } from '@/app/_authed/(extension-runtime)/_client/host'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { assertUniqueNodeTypeIds } from '@/app/_authed/(extension-runtime)/_node-type-guard'
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
  const [scope, slug] = extensionId.split('/')
  return `/api/ext/${scope}/${slug}/${file}?v=${version}`
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
  const [scope, slug] = extensionId.split('/')
  const href = bundleUrl(extensionId, 'client.css', version)
  const id = `ext-css-${scope}-${slug}`
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
  manifest: ExtensionManifest,
  clientVersion?: number,
): Promise<ExtensionDeclaration | null> {
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
    return {
      ...decl,
      manifest: { ...decl.manifest, id: manifest.id },
    }
  } catch (err) {
    console.error(`[ext] ${manifest.id}: load failed`, err)
    return null
  }
}

export async function loadExtension(
  manifest: ExtensionManifest,
  clientVersion?: number,
): Promise<ExtensionDeclaration | null> {
  const decl = await importExtension(manifest, clientVersion)
  if (decl) {
    extensionRegistry.register(decl)
  }
  return decl
}

export async function loadAllExtensions(): Promise<ExtensionDeclaration[]> {
  const manifests: ExtensionManifestInfo[] = await listExtensionManifests()
  const withClient = manifests.filter((manifest) => manifest.hasClient)
  // Imported concurrently: the previous serial loop paid one round trip per
  // extension, back to back. `injectStyles` still runs in manifest order —
  // each call happens synchronously before its first await — so the cascade
  // order of the extension stylesheets is unaffected.
  const declarations = await Promise.all(
    withClient.map((manifest) => importExtension(manifest, manifest.clientVersion)),
  )
  const loaded = declarations.filter((decl): decl is ExtensionDeclaration => decl !== null)
  // A duplicate typeId across two extensions is a configuration error, not a
  // race to be resolved by ordering — checked here, over every bundle's real
  // declared nodes, before any of them register. (extension.json's own
  // `nodes` field is only a hint for lazy palette discovery and can be stale
  // relative to what a bundle actually declares, so this can't be checked
  // any earlier than this, once each bundle has actually been evaluated.)
  assertUniqueNodeTypeIds(
    loaded.map((decl) => ({ extensionId: decl.manifest.id, typeIds: (decl.nodes ?? []).map((n) => n.typeId) })),
  )
  for (const decl of loaded) {
    extensionRegistry.register(decl)
  }
  return loaded
}
