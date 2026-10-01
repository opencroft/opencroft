import type { AppEntry } from '@opencroft/core'

import type { ExtensionDeclaration, LoadedExtensionDeclaration } from '@/app/_authed/(extension-runtime)/_client/host'
import { qualifyDeclared, qualifyHandleTypes } from '@/app/_authed/(extension-runtime)/_declared-types'

// An App as a bundle may declare it: `type`, or the deprecated `slug` in its place.
type DeclaredApp = Omit<AppEntry, 'type'> & { type?: string }

/**
 * File a bundle's declaration under the id and folder the server serves its
 * extension as, with every type it declares qualified with that id — the same
 * rule its manifest is read by, so the two halves of one extension agree.
 *
 * The id a bundle declares itself is never used: it would name one extension's
 * nodes and settings in another's place, and a local copy standing in for an
 * installed extension (see `folderOf`) has to register under the id it stands
 * in for, whatever its source says. A bundle that still declares a different id
 * is named in a warning so its author can drop it.
 *
 * Throws, naming the extension, for a declaration that cannot be qualified.
 */
export function loadedDeclaration(
  decl: ExtensionDeclaration,
  served: { id: string; folder: string },
): LoadedExtensionDeclaration {
  if (decl.manifest.id !== undefined && decl.manifest.id !== served.id) {
    console.warn(
      `[ext] ${served.id}: the bundle declares manifest.id "${decl.manifest.id}", which is ignored — the host supplies the id`,
    )
  }
  const { contexts, handleTypes, nodes, provides, ...rest } = decl
  const loaded: LoadedExtensionDeclaration = {
    ...rest,
    manifest: { ...decl.manifest, id: served.id, folder: served.folder },
  }
  const qualifiedHandleTypes = qualifyHandleTypes(served.id, handleTypes, contexts)
  if (qualifiedHandleTypes) {
    loaded.handleTypes = qualifiedHandleTypes
  }
  if (nodes) {
    loaded.nodes = qualifyDeclared(served.id, 'node type', 'typeId', nodes)
  }
  if (provides) {
    const apps = provides.apps as DeclaredApp[] | undefined
    loaded.provides = apps ? { ...provides, apps: qualifyDeclared(served.id, 'App type', 'slug', apps) } : provides
  }
  return loaded
}
