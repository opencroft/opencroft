import path from 'node:path'

const PROJECT_ROOT = process.cwd()

/** Sidecar an install writes into the extension folder to record where it came from. */
export const SIDECAR_FILE = 'installed.json'

/**
 * Files the install/build machinery writes into an extension's working tree by
 * design, relative to the checkout root.
 *
 * These are generated, not authored, and the extension repositories do not
 * ignore them — so a plain "does this tree have uncommitted changes" reads true
 * for most checkouts most of the time. Anything deciding whether someone has
 * work in progress in a checkout has to discount these first, or it is only
 * ever reporting that a build has run.
 */
export const BUILD_ARTIFACT_FILES = [SIDECAR_FILE, 'package-lock.json']

export function localExtRoot(): string {
  return process.env.OPENCROFT_LOCAL_EXTENSIONS ?? path.join(PROJECT_ROOT, 'data', 'extensions', 'local')
}

export function installedExtRoot(): string {
  return process.env.OPENCROFT_INSTALLED_EXT_ROOT ?? path.join(PROJECT_ROOT, 'data', 'extensions', 'installed')
}

export function builtinExtRoot(): string {
  return path.join(PROJECT_ROOT, 'app', '_authed', '(extension-runtime)', '_builtin')
}

export function extDir(extensionId: string): string {
  const [scope, slug] = extensionId.split('/')
  if (scope === 'builtin') {
    return path.join(builtinExtRoot(), slug)
  }
  if (scope === 'installed') {
    return path.join(installedExtRoot(), slug)
  }
  return path.join(localExtRoot(), slug)
}

export function extDistDir(extensionId: string): string {
  return path.join(extDir(extensionId), 'dist')
}

export function extDistFile(extensionId: string, name: string): string {
  return path.join(extDistDir(extensionId), name)
}

export function projectRoot(): string {
  return PROJECT_ROOT
}
