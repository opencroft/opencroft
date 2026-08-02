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
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.output', 'public')

// The full Node builtin set rather than a hand-kept list, so a leak through a
// less obvious module (`events`, `buffer`, `dns`, `perf_hooks`, …) fails too.
// Plus the native-dependent packages that have actually reached the browser
// this way, which are ordinary npm names and so not covered by the above.
const NATIVE_PACKAGES = ['esbuild', 'ssh2', '@tailwindcss/node', 'jiti', 'lightningcss']
const FORBIDDEN = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...NATIVE_PACKAGES])

// Deliberately NOT "flag every non-relative specifier", which would be stronger
// in principle but false-positives on the real output today: dynamic imports
// built from template literals (`@xyflow/${e}/dist/style.css`), the extension
// runtime's `@ext/host` module key, and minifier artifacts all read as bare.
// Matching an exact known-forbidden name keeps this a signal rather than noise.
const SPECIFIER = /(?:\bfrom\s*|(?:^|[^.\w])\bimport\s*\(?\s*)["']([^"']+)["']/g

function offendingSpecifiers(code) {
  const hits = new Set()
  for (const match of code.matchAll(SPECIFIER)) {
    if (FORBIDDEN.has(match[1])) {
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
    const hits = offendingSpecifiers(await readFile(file, 'utf8'))
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

await main()
