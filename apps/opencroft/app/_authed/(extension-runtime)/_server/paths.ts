import path from 'node:path'

import { BUILTIN_OWNER, isBuiltinFolder, parseExtensionId } from '@/app/_authed/(extension-runtime)/_extension-id'
import { dataDir } from '@/server/data-dir'

const PROJECT_ROOT = process.cwd()

/**
 * Written into `dist/` by a successful build to record the commit the bundle was
 * produced from — the commit the instance is actually RUNNING, which can now lag
 * the checkout's own HEAD, because the auto-rebuild refuses a dirty or off-branch
 * checkout rather than republishing it. Lives inside `dist/`, which extension
 * repos ignore, so recording it never makes a checkout read dirty.
 */
export const BUILD_PROVENANCE_FILE = 'built.json'

/**
 * Written into `dist/` by a client build: the icon names the extension's client
 * code names in its source, as a JSON array. The browser preloads them before
 * the extension renders, so its icons are there on its first paint.
 */
export const CLIENT_ICONS_FILE = 'icons.json'

/** Where every extension folder lives: `<data dir>/extensions/<extensionFolder>/`. */
export function extensionsRoot(): string {
  return dataDir('extensions')
}

/** Where builtin extensions' sources live: inside the app, which imports them directly. */
export function builtinSourceRoot(): string {
  return path.join(PROJECT_ROOT, 'app', '_authed', '(extension-runtime)', '_builtin')
}

/** The source directory of an extension folder: `builtin.core` is `_builtin/core` in the app. */
export function folderDir(folder: string): string {
  const parsed = parseExtensionId(folder)
  if (parsed?.owner === BUILTIN_OWNER) {
    return path.join(builtinSourceRoot(), parsed.extension)
  }
  return path.join(extensionsRoot(), folder)
}

/**
 * An extension folder's build output: `dist/` inside it. A builtin's sources are
 * in the app tree, so its build goes to the folder of the same name under the
 * extensions root instead, which holds nothing but that `dist/`.
 */
export function folderDistDir(folder: string): string {
  if (isBuiltinFolder(folder)) {
    return path.join(extensionsRoot(), folder, 'dist')
  }
  return path.join(folderDir(folder), 'dist')
}

declare global {
  var __EXT_FOLDER_BY_ID__: Map<string, string> | undefined
}

// extensionId → extensionFolder, as the extension index last resolved it (see
// extension-folders.ts). On globalThis so a dev-server module reload keeps it.
// Absent until the first scan: `folderOf` answers the same for "not overridden"
// and "never scanned", so only this being unset tells them apart.

/** Replace the resolved extensionId → extensionFolder map. Called by the extension index only. */
export function setResolvedFolders(resolved: Map<string, string>): void {
  globalThis.__EXT_FOLDER_BY_ID__ = new Map(resolved)
}

/** Whether the extension index has run in this process, so `folderOf` reflects the folders on disk. */
export function hasResolvedFolders(): boolean {
  return globalThis.__EXT_FOLDER_BY_ID__ !== undefined
}

/**
 * The folder an extension runs from. An id the index has not resolved differently
 * is its own folder: every extension lives in the folder named by its id, except
 * a local copy standing in for another extension.
 */
export function folderOf(extensionId: string): string {
  return globalThis.__EXT_FOLDER_BY_ID__?.get(extensionId) ?? extensionId
}

export function extDir(extensionId: string): string {
  return folderDir(folderOf(extensionId))
}

export function extDistDir(extensionId: string): string {
  return folderDistDir(folderOf(extensionId))
}

export function extDistFile(extensionId: string, name: string): string {
  return path.join(extDistDir(extensionId), name)
}

export function projectRoot(): string {
  return PROJECT_ROOT
}

/**
 * Where one build attempt stages its output before publishing it: a directory
 * inside `dist/`, so publishing is a rename on the same device and the checkout
 * never sees it (extension repos ignore `dist/`). Unique per attempt, so a
 * leftover from a crashed build can never collide with a running one.
 */
export function stagingName(distDir: string, attempt: number): string {
  return path.join(distDir, `.building-${process.pid}-${attempt}`)
}

const STAGING_NAME = /^\.building-\d+-\d+$/

/** Whether an entry of `dist/` is one of `stagingName`'s per-attempt directories. */
export function isStagingName(name: string): boolean {
  return STAGING_NAME.test(name)
}
