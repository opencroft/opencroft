'use client'

import { type ExtensionDeclaration, installClientHost } from '@/app/(extension-runtime)/_client/host'
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry'
import { listExtensionManifests } from '@/app/(extension-runtime)/_server/actions'
import type { ExtensionManifest } from '@/app/(extension-runtime)/_types'

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

export async function loadExtension(manifest: ExtensionManifest): Promise<ExtensionDeclaration | null> {
  installClientHost()
  const url = bundleUrl(manifest.id, Date.now())
  try {
    const mod = await importBundle(url)
    const decl = mod.default ?? mod.extension
    if (!decl || !decl.manifest) {
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
  const manifests = await listExtensionManifests()
  const loaded: ExtensionDeclaration[] = []
  for (const manifest of manifests) {
    const decl = await loadExtension(manifest)
    if (decl) {
      loaded.push(decl)
    }
  }
  return loaded
}
