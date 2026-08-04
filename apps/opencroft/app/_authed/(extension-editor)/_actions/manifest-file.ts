// Reading and rewriting an installed extension's manifest on disk.
//
// Kept out of `installed-extensions-actions.ts` deliberately. That file is
// imported by client components — which is the normal way to call the server
// functions it exports — and the client build can only drop its import tail
// (`node:child_process`, `node:fs`, the extension compiler) if EVERY export in
// it is a `createServerFn` it can replace with an RPC stub. One plain export
// there is enough to keep those imports in the browser's module graph.
//
// So this is a plain module with plain exports, and nothing client-side
// imports it.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

export const MANIFEST_FILE = 'extension.json'

// The manifest is rewritten in place, so its existing formatting is preserved
// rather than normalised: reformatting it to a fixed style on install leaves
// every checkout permanently dirty against the repository it came from.
function detectJsonIndent(raw: string): string | number {
  const match = raw.match(/\n([ \t]+)\S/)
  if (!match) {
    return 0
  }
  return match[1].includes('\t') ? '\t' : match[1].length
}

export async function rewriteManifestId(dir: string, scopedId: string): Promise<ExtensionManifest> {
  const file = path.join(dir, MANIFEST_FILE)
  const raw = await fs.readFile(file, 'utf-8')
  const manifest = JSON.parse(raw) as ExtensionManifest
  manifest.id = scopedId
  if (!manifest.version) {
    manifest.version = '0.0.0'
  }
  const indent = detectJsonIndent(raw)
  const trailingNewline = raw.endsWith('\n') ? '\n' : ''
  await fs.writeFile(file, JSON.stringify(manifest, null, indent) + trailingNewline, 'utf-8')
  return manifest
}
