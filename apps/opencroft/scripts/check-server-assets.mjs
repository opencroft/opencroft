#!/usr/bin/env node

// Fails the build if the server bundle names an asset the client build did not
// emit.
//
// The server and client halves are separate Vite builds. Each computes an
// asset's hashed name (`import appCss from '…/globals.css?url'`) from what it
// compiled itself, and the server bakes that name into the HTML it renders.
// When the two builds compile an asset differently, the page links a file that
// does not exist and loads without its stylesheet, while both builds succeed.
// Tailwind is one way they diverge: its source scan honours `.gitignore`, and
// without that file the server build also scans the client build's freshly
// written `.output`, so the server's stylesheet differs from the client's.
//
// Neither `tsc` nor the unit tests can see this, so it is asserted here,
// against the built output.

import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.output')
const SERVER_DIR = join(OUTPUT_DIR, 'server')
const PUBLIC_DIR = join(OUTPUT_DIR, 'public')

// A quoted root-relative path into the client's `assets/` that names a file.
// Route patterns such as `/assets/**` carry no extension, so they don't match.
const ASSET_REFERENCE = /["'`](\/assets\/[\w.-]+\.[a-z0-9]+)["'`]/g

/** The `/assets/…` files `code` names, each once. */
export function assetReferences(code) {
  return [...new Set(Array.from(code.matchAll(ASSET_REFERENCE), (match) => match[1]))]
}

async function serverFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await serverFiles(full)))
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

async function main() {
  let files
  try {
    files = await serverFiles(SERVER_DIR)
  } catch {
    console.error(`[check-server-assets] no built output at ${SERVER_DIR} — run the build first`)
    process.exit(1)
  }

  const referencedBy = new Map()
  for (const file of files) {
    for (const asset of assetReferences(await readFile(file, 'utf8'))) {
      referencedBy.set(asset, [...(referencedBy.get(asset) ?? []), relative(OUTPUT_DIR, file)])
    }
  }

  const missing = []
  for (const [asset, from] of referencedBy) {
    const exists = await access(join(PUBLIC_DIR, asset))
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      missing.push({ asset, from })
    }
  }

  if (missing.length > 0) {
    console.error('[check-server-assets] the server names assets the client build did not emit:\n')
    for (const { asset, from } of missing) {
      console.error(`  ${asset}\n    named in: ${from.join(', ')}`)
    }
    console.error(
      '\nThe server and client builds compiled the asset differently. A stylesheet that\n' +
        'differs usually means Tailwind scanned different files in the two builds: check\n' +
        'that `.gitignore` is present where the build runs (it is what keeps `.output` out).\n',
    )
    process.exit(1)
  }

  console.log(`[check-server-assets] ok — ${referencedBy.size} assets named by the server, all under .output/public`)
}

// Only when run as a script. Importing this module — which the test does —
// must not run the check or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
