'use client'

import { type ExtensionDeclaration, installClientHost } from '@/app/(extension-runtime)/_client/host'
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry'
import { listExtensionManifests } from '@/app/(extension-runtime)/_server/actions'
import type { ExtensionManifest, ExtensionManifestInfo } from '@/app/(extension-runtime)/_types'

interface LoadedModule {
  default?: ExtensionDeclaration
  extension?: ExtensionDeclaration
}

function bundleUrl(extensionId: string, cacheKey: number): string {
  const [scope, slug] = extensionId.split('/')
  return `/api/ext/${scope}/${slug}/client.js?v=${cacheKey}`
}

async function importBundle(url: string): Promise<LoadedModule> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<LoadedModule>
}

// Each extension ships a runtime-compiled stylesheet (utilities for the
// classes its client code uses, referencing the host theme). Inserted BEFORE
// the host styles: when both sheets define the same utility, the host's
// canonical Tailwind ordering must win the cascade — an extension sheet loaded
// after the host would e.g. let its `.hidden` override the host's `md:block`.
function injectStyles(extensionId: string, cacheKey: number): void {
  const [scope, slug] = extensionId.split('/')
  const href = `/api/ext/${scope}/${slug}/client.css?v=${cacheKey}`
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

export async function loadExtension(manifest: ExtensionManifest): Promise<ExtensionDeclaration | null> {
  installClientHost()
  const cacheKey = Date.now()
  const url = bundleUrl(manifest.id, cacheKey)
  injectStyles(manifest.id, cacheKey)
  try {
    const mod = await importBundle(url)
    const decl = mod.default ?? mod.extension
    if (!decl?.manifest) {
      console.error(`[ext] ${manifest.id}: bundle default export is not a valid ExtensionDeclaration`)
      return null
    }
    const aligned: ExtensionDeclaration = {
      ...decl,
      manifest: { ...decl.manifest, id: manifest.id },
    }
    extensionRegistry.register(aligned)
    return aligned
  } catch (err) {
    console.error(`[ext] ${manifest.id}: load failed`, err)
    return null
  }
}

export async function loadAllExtensions(): Promise<ExtensionDeclaration[]> {
  const manifests: ExtensionManifestInfo[] = await listExtensionManifests()
  const loaded: ExtensionDeclaration[] = []
  for (const manifest of manifests) {
    if (!manifest.hasClient) {
      continue
    }
    const decl = await loadExtension(manifest)
    if (decl) {
      loaded.push(decl)
    }
  }
  return loaded
}
