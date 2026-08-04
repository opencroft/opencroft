#!/usr/bin/env node

// Fails if this package imports a workspace package it does not declare as a
// dependency in its own package.json.
//
// The failure this catches: startup.ts imported a workspace package bare,
// but apps/opencroft/package.json never listed it as a dependency. Every dev
// worktree resolved it anyway -- a root-level `npm install`/`npm ci` links
// every workspace member unconditionally, regardless of who declares what.
// A deploy that runs `npm install` (not `ci`) from *inside* this package's
// own directory, against a node_modules that already existed before the new
// package was added -- and npm, scoped to this package's own context, only
// relinks workspace dependencies this package.json actually declares. An
// import with no declaration is invisible to that install, so it silently
// worked everywhere this check wasn't run and broke only on the one install
// path that matters.
//
// This is a source check, not an install simulation: it does not attempt to
// reproduce npm's own linking behavior (which is exactly what silently
// varied here), it just asserts the one thing that makes that variance
// irrelevant -- every workspace package actually imported is also actually
// declared. A package.json that declares everything it imports gets linked
// the same way regardless of which directory `npm install` runs from.

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_DIR, '../..')

async function sourceFiles(dir, found = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.output' || entry.name === 'dist') {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await sourceFiles(full, found)
    } else if (/\.(tsx?|mjs|jsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

// Every workspace member's declared package name, discovered from disk rather
// than the workspaces glob string -- this is the ground truth for "is this
// specifier a workspace package" regardless of how the glob is spelled.
async function workspacePackageNames() {
  const names = new Set()
  for (const group of ['apps', 'packages']) {
    let entries
    try {
      entries = await readdir(join(REPO_ROOT, group), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const pkg = JSON.parse(await readFile(join(REPO_ROOT, group, entry.name, 'package.json'), 'utf8'))
        if (pkg.name) names.add(pkg.name)
      } catch {
        // No package.json, or unparsable -- not a workspace member.
      }
    }
  }
  return names
}

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

async function main() {
  const ownPkg = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8'))
  const declared = new Set([...Object.keys(ownPkg.dependencies ?? {}), ...Object.keys(ownPkg.devDependencies ?? {})])
  const workspaceNames = await workspacePackageNames()

  const files = [
    ...(await sourceFiles(join(APP_DIR, 'app'))),
    ...(await sourceFiles(join(APP_DIR, 'server'))),
    ...(await sourceFiles(join(APP_DIR, 'scripts'))),
  ]

  // file -> Set(undeclared package names), so one file importing the same
  // missing package twice is reported once.
  const failures = new Map()
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const pkgName = packageNameFromSpecifier(match[1])
      if (!pkgName || pkgName === ownPkg.name) continue
      if (!workspaceNames.has(pkgName)) continue // external package, npm's own resolution covers it
      if (declared.has(pkgName)) continue
      const rel = relative(APP_DIR, file)
      if (!failures.has(rel)) failures.set(rel, new Set())
      failures.get(rel).add(pkgName)
    }
  }

  if (failures.size > 0) {
    console.error('[check-workspace-deps] workspace package imported but not declared as a dependency:\n')
    for (const [file, pkgs] of failures) {
      console.error(`  ${file}: ${[...pkgs].join(', ')}`)
    }
    console.error(
      '\nAdd each one to apps/opencroft/package.json\'s "dependencies" (matching how the existing\n' +
        'workspace packages are declared). A bare import with no declaration happens to resolve in\n' +
        'every dev worktree, where npm links every workspace member unconditionally -- it is not\n' +
        'guaranteed to resolve wherever npm install runs scoped to this package specifically.\n',
    )
    process.exit(1)
  }

  console.log(`[check-workspace-deps] ok — ${files.length} source files, every workspace import is declared`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
