#!/usr/bin/env node

// Fails the build if a browser chunk imports a Node builtin or a known
// server-only native package.
//
// This catches one specific, recurring way to break the app: server-only code
// leaking into the client bundle. Most server modules reach the client graph
// legitimately — a `'use client'` component importing a `createServerFn` is the
// normal way to call one — and stay harmless only because the client build
// replaces each server function with an RPC stub, which leaves that module's own
// imports unused and lets them be dropped.
//
// Add one plain (non-`createServerFn`) export to such a file and there is no
// stub, so its real import tail ships: the browser then hits `import
// "node:fs"` (or esbuild/ssh2/@tailwindcss/node behind it), cannot resolve it,
// fails to link the module graph, and the page renders as a stuck spinner with
// nothing but a console error to go on.
//
// Neither `tsc` nor the unit tests can see this — it is a bundler-level
// outcome — so it is asserted here, against the built output.

import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.output', 'public')

// The full Node builtin set rather than a hand-kept list, so a leak through a
// less obvious module (`events`, `buffer`, `dns`, `perf_hooks`, …) fails too.
// Plus server-only packages, which are ordinary npm names and so not covered by
// the above: the native-dependent ones that have actually reached the browser
// this way, and the database stack, which is server-only for the same reason
// but had never been listed — a leak through it would have passed this check.
const SERVER_ONLY_PACKAGES = [
  'esbuild',
  'ssh2',
  '@tailwindcss/node',
  'jiti',
  'lightningcss',
  '@electric-sql/pglite',
  'drizzle-orm',
  'pg',
  'postgres',
]
const FORBIDDEN = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...SERVER_ONLY_PACKAGES])

// A specifier is forbidden if it names one of the above OR reaches into one:
// `drizzle-orm/pg-core` and `ssh2/lib/client` are the same leak as the bare
// name, and matching only the exact string missed both.
export function isForbidden(specifier) {
  if (FORBIDDEN.has(specifier)) {
    return true
  }
  return SERVER_ONLY_PACKAGES.some((name) => specifier.startsWith(`${name}/`))
}

// Deliberately NOT "flag every non-relative specifier", which would be stronger
// in principle but false-positives on the real output today: dynamic imports
// built from template literals (`@xyflow/${e}/dist/style.css`), the extension
// runtime's `@ext/host` module key, and minifier artifacts all read as bare.
// Matching an exact known-forbidden name keeps this a signal rather than noise.
const SPECIFIER = /(?:\bfrom\s*|(?:^|[^.\w])\bimport\s*\(?\s*)["']([^"']+)["']/g

// A specifier scan only sees what stayed EXTERNAL. A pure-JavaScript package is
// bundled inline instead, so no specifier survives for the scan above to match
// and the leak is invisible to it — verified by importing `drizzle-orm/pg-core`
// into a client component: the emitted chunk contained the library's internals
// and the specifier scan reported the bundle clean.
//
// So bundled packages are matched on a fingerprint of their own code. The
// fingerprint must be something the library emits and nothing else plausibly
// contains: grepping for the bare package name is NOT safe, because a clean
// bundle already contains the string "drizzle" — it is the name of a lucide
// icon (`cloud-drizzle`). A namespaced symbol tag cannot collide that way.
//
// Only fingerprints that have been verified against a real build belong here.
// An unverified guess would fail in whichever direction nobody checked.
const BUNDLED_FINGERPRINTS = [{ pkg: 'drizzle-orm', marker: 'drizzle:entityKind' }]

export function bundledFingerprints(code) {
  return BUNDLED_FINGERPRINTS.filter(({ marker }) => code.includes(marker)).map(({ pkg }) => `${pkg} (bundled)`)
}

export function offendingSpecifiers(code) {
  const hits = new Set()
  for (const match of code.matchAll(SPECIFIER)) {
    if (isForbidden(match[1])) {
      hits.add(match[1])
    }
  }
  return [...hits]
}

// Everything under .output/public, at any depth — a future chunking change that
// emits outside assets/ must not make this check quietly stop looking.
async function scriptFiles(dir) {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await scriptFiles(full)
      if (nested) {
        found.push(...nested)
      }
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

async function main() {
  const files = await scriptFiles(PUBLIC_DIR)
  if (files === null) {
    console.error(`[check-client-bundle] no built output at ${PUBLIC_DIR} — run the build first`)
    process.exit(1)
  }

  const failures = []
  for (const file of files) {
    const code = await readFile(file, 'utf8')
    const hits = [...offendingSpecifiers(code), ...bundledFingerprints(code)]
    if (hits.length > 0) {
      failures.push({ file: relative(PUBLIC_DIR, file), hits })
    }
  }

  if (failures.length > 0) {
    console.error('[check-client-bundle] server-only code reached the browser bundle:\n')
    for (const { file, hits } of failures) {
      console.error(`  ${file}\n    imports: ${hits.join(', ')}`)
    }
    console.error(
      '\nA module reachable from client code most likely gained a plain, non-createServerFn\n' +
        'export, so its imports were no longer dropped. Move that helper into a server-only\n' +
        'module the client graph never reaches — making the import lazy does not help.\n',
    )
    process.exit(1)
  }

  console.log(`[check-client-bundle] ok — ${files.length} scripts under .output/public, no server-only imports`)
}

// Only when run as a script. Importing this module — which the test does —
// must not run the check or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
