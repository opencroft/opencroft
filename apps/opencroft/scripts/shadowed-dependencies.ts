import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The server build leaves a dependency of the source it bundles as a bare
// import (`import { Marked } from 'marked'`), and that import is resolved
// later from where the built server sits: the app's directory, then the
// repository root. Dev resolves the same import from the file that wrote it.
// The two agree only while there is one copy of the package. When a workspace
// package depends on another version than the one installed for the app, npm
// gives that package a copy of its own, under its own `node_modules`; dev
// uses it, and the built server quietly uses the app's copy instead.
//
// agent-chat's markdown converter, for one, is written for marked 17, which
// reads an inline code span's text as written. The app's own copy is marked 14
// (monaco-editor's), which HTML-escapes that text as it reads it: on it, every
// save of a page escapes `<`, `>`, `&` and quotes in its code spans once more.
//
// Bundling such a package into the server build resolves it from the file that
// imports it, as dev does. The list is read from the installed packages, so a
// version split that appears later is bundled without anyone editing it.

function versionAt(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/** The packages installed directly in `dir/node_modules`, scoped ones by their full name. */
function installedIn(dir: string): string[] {
  const nodeModules = join(dir, 'node_modules')
  if (!existsSync(nodeModules)) {
    return []
  }
  const names: string[] = []
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) {
      continue
    }
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(nodeModules, entry))) {
        names.push(`${entry}/${scoped}`)
      }
    } else {
      names.push(entry)
    }
  }
  return names
}

/** The version of `name` that a bare import resolves to from `dir`, as Node looks it up; null when none does. */
function versionResolvedFrom(dir: string, name: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const version = versionAt(join(at, 'node_modules', name))
    if (version !== null) {
      return version
    }
    if (dirname(at) === at) {
      return null
    }
  }
}

/**
 * The packages that a workspace package in `packagesDir` holds its own copy
 * of, at another version than a bare import from `appDir` resolves to.
 */
export function shadowedDependencies(appDir: string, packagesDir: string): string[] {
  const shadowed = new Set<string>()
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const packageDir = join(packagesDir, entry.name)
    for (const name of installedIn(packageDir)) {
      if (versionAt(join(packageDir, 'node_modules', name)) !== versionResolvedFrom(appDir, name)) {
        shadowed.add(name)
      }
    }
  }
  return [...shadowed].sort()
}
