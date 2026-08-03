import path from 'node:path'

const PROJECT_ROOT = process.cwd()

export function localExtRoot(): string {
  return process.env.OPENCROFT_LOCAL_EXTENSIONS ?? path.join(PROJECT_ROOT, 'data', 'extensions', 'local')
}

export function installedExtRoot(): string {
  return process.env.OPENCROFT_INSTALLED_EXT_ROOT ?? path.join(PROJECT_ROOT, 'data', 'extensions', 'installed')
}

export function builtinExtRoot(): string {
  return path.join(PROJECT_ROOT, 'app', '(extension-runtime)', '_builtin')
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
