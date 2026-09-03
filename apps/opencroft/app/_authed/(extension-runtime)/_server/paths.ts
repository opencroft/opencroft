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

/**
 * The name a build output is staged under while a compile is writing it —
 * beside its final path (same device, so publishing is an atomic rename),
 * unique per attempt so a leftover from a crashed build can never collide with
 * a running one.
 */
export function stagingName(finalPath: string, attempt: number): string {
  return `${finalPath}.building-${process.pid}-${attempt}`
}

const STAGING_SUFFIX = /\.building-\d+-\d+$/

/** Whether a directory entry is one of `stagingName`'s per-attempt outputs. */
export function isStagingName(name: string): boolean {
  return STAGING_SUFFIX.test(name)
}

/**
 * Whether a `git status` path is the client build's staging DIRECTORY — the one
 * staging name that lands outside `dist/`, as its sibling at the checkout root.
 * Extension repos ignore `dist/` but cannot ignore this (the name varies per
 * attempt), so the dirty classification discounts it by shape: it is the build
 * machinery's own write, visible for as long as a build runs — or forever, if
 * that build was killed — and never authored work. Anchored to the root; a
 * deeper path of the same shape stays an authored change.
 */
export function isStagingArtifactPath(statusPath: string): boolean {
  const value = statusPath.endsWith('/') ? statusPath.slice(0, -1) : statusPath
  return value.startsWith('dist.building-') && isStagingName(value)
}

/**
 * Written into `dist/` by a successful build to record the commit the bundle was
 * produced from — the commit the instance is actually RUNNING, which can now lag
 * the checkout's own HEAD, because the auto-rebuild refuses a dirty or off-branch
 * checkout rather than republishing it. Lives inside `dist/`, which extension
 * repos ignore, so recording it never makes a checkout read dirty.
 */
export const BUILD_PROVENANCE_FILE = 'built.json'

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
