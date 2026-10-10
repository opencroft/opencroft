// Running biome: which binary, which config, which files.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The one config every repository is held to. Named so biome never mistakes
 *  it for a nested project config while scanning the core repository. */
export const SHARED_CONFIG = path.resolve(HERE, '..', 'biome.shared.json')

/**
 * The lockfile-pinned biome of the repository this package lives in, by path.
 *
 * Never `npx biome`: with no local install it does not fail, it fetches an
 * unrelated package of that name which prints nothing and exits 0, and a lint
 * gate reporting clean because it ran the wrong program is the worst outcome
 * available here. Resolved from this package rather than from the repository
 * being checked, so an extension is held to the same version as the core.
 */
export function biomeBinary() {
  let pkg
  try {
    pkg = createRequire(import.meta.url).resolve('@biomejs/biome/package.json')
  } catch {
    throw new Error('no @biomejs/biome beside @opencroft/dev-tools — run `npm ci` in the core repository')
  }
  const bin = path.join(path.dirname(pkg), 'bin', 'biome')
  if (!existsSync(bin)) {
    throw new Error(`@biomejs/biome has no binary at ${bin}`)
  }
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' })
    .trim()
    .replace(/^Version:\s*/, '')
  return { bin, version }
}

/**
 * Config arguments for a repository. One that keeps its own biome.json (the
 * core repository: it extends the shared file and adds what only it needs) is
 * left to biome's own discovery. One that keeps none gets the shared file
 * directly, so an extension needs no copy of it.
 */
export function configArgs(root) {
  const own = ['biome.json', 'biome.jsonc'].some((name) => existsSync(path.join(root, name)))
  return own ? [] : [`--config-path=${SHARED_CONFIG}`]
}

/**
 * biome over an explicit file list, from the repository root.
 *
 * Explicit, because the list is where installed files and untouched files are
 * left out; biome's own `files.includes` still applies on top of it, so a path
 * the config excludes is skipped even when it is named. Files biome has no
 * language for are skipped rather than reported.
 */
export function runBiome(root, files, extra) {
  const { bin } = biomeBinary()
  return spawnSync(
    bin,
    ['check', ...configArgs(root), '--files-ignore-unknown=true', '--no-errors-on-unmatched', ...extra, ...files],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
}
