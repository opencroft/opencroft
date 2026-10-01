import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AppEntry, AppHandle } from '@opencroft/core'

import { qualifyDeclared, qualifyHandleTypes } from '@/app/_authed/(extension-runtime)/_declared-types'
import { MANIFEST_FILE } from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import { extDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionHandle, ExtensionManifest, NodeMetadata } from '@/app/_authed/(extension-runtime)/_types'

/** The version an extension whose manifest declares none is shown with. */
export const DEFAULT_VERSION = '0.0.0'

// A manifest as its author wrote it: each renamed key may be missing, with the
// deprecated key it replaces standing in for it.
type DeclaredHandle = Omit<ExtensionHandle, 'handleType'> & { handleType?: string }
type DeclaredNode = Omit<NodeMetadata, 'type' | 'handles'> & { type?: string; handles?: DeclaredHandle[] }
type DeclaredAppHandle = Omit<AppHandle, 'handleType'> & { handleType?: string }
type DeclaredApp = Omit<AppEntry, 'type' | 'handles'> & { type?: string; handles?: DeclaredAppHandle[] }
export type DeclaredManifest = Omit<ExtensionManifest, 'nodes'> & { nodes?: DeclaredNode[] }

/**
 * An extension's manifest as the runtime uses it, read from the folder serving
 * `extensionId`. Normalized in memory and never written back — see
 * `normalizeManifest`.
 */
export async function readManifest(extensionId: string): Promise<ExtensionManifest> {
  const file = path.join(extDir(extensionId), MANIFEST_FILE)
  const manifest = JSON.parse(await fs.readFile(file, 'utf-8')) as DeclaredManifest
  return normalizeManifest(manifest, extensionId)
}

/**
 * The one place a declared manifest becomes the manifest the runtime uses.
 *
 * `id` is the id the extension runs under — which for a local copy of another
 * extension is that extension's id, not its folder's — and a missing `version`
 * reads as DEFAULT_VERSION. Every node type, App type and handle type comes
 * back qualified with that id, under its current key only: `type`,
 * `handleType`, `handleTypes`. A deprecated key is read where its replacement
 * is absent; where both are present and disagree, the replacement wins and a
 * warning names the extension and the key.
 *
 * Throws, naming the extension, for a declaration the runtime cannot qualify:
 * a declared type that is not a bare slug (a dot in it would make the
 * qualified form ambiguous), one bare type declared twice among the nodes or
 * among the Apps, or a handle type that is neither bare nor qualified.
 */
export function normalizeManifest(declared: DeclaredManifest, extensionId: string): ExtensionManifest {
  const { contexts, handleTypes, nodes, provides, ...rest } = declared
  const manifest: ExtensionManifest = { ...rest, id: extensionId, version: declared.version || DEFAULT_VERSION }
  const qualifiedHandleTypes = qualifyHandleTypes(extensionId, handleTypes, contexts)
  if (qualifiedHandleTypes) {
    manifest.handleTypes = qualifiedHandleTypes
  }
  if (nodes) {
    manifest.nodes = qualifyDeclared(extensionId, 'node type', 'typeId', nodes)
  }
  if (provides) {
    const apps = provides.apps as DeclaredApp[] | undefined
    manifest.provides = apps ? { ...provides, apps: qualifyDeclared(extensionId, 'App type', 'slug', apps) } : provides
  }
  return manifest
}

/**
 * For surfaces that show an extension rather than run it: the manifest as the
 * runtime reads it or, when the runtime refuses it, its identity alone — so an
 * extension whose declaration is broken can still be listed, opened and fixed.
 */
export function manifestForDisplay(declared: DeclaredManifest, extensionId: string): ExtensionManifest {
  try {
    return normalizeManifest(declared, extensionId)
  } catch (error) {
    console.warn(`[ext] ${extensionId}: showing the manifest without its types —`, error)
    const { nodes: _nodes, handleTypes: _handleTypes, contexts: _contexts, provides: _provides, ...identity } = declared
    return normalizeManifest(identity, extensionId)
  }
}
