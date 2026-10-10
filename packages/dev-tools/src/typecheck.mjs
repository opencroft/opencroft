// `opencroft-dev typecheck`: every type error of the repository, with nothing
// tolerated.
//
// In the core repository that is `npm run typecheck`, every workspace's own
// typecheck. In an extension repository it is tsc against the host's types.
//
// WHERE AN EXTENSION IS CHECKED
//
// An extension's types resolve only from inside a core tree
// (extension-typecheck.mjs). A checkout that already sits in one — an
// instance's `apps/opencroft/data/extensions/local.<name>` — is checked in
// place. Anywhere else, a task worktree of the extension's own repository most
// of all, it is copied into the core tree this package belongs to, under
// `apps/opencroft/.opencroft-dev/`, given its own dependencies there, and
// checked as the copy. Run with `tsc` from outside a core tree, the same code
// would typecheck nothing at all and exit clean; checking the copy prevents that.
//
// The copy is what git lists (tracked, plus untracked and not ignored), kept
// between runs and re-synced each time; its dependencies are reinstalled only
// when package.json or the lockfile changed. Peer dependencies are not
// installed: they are the host's to provide, and the host is what the copy
// resolves them from.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  filesOnDeprecatedSpecifiers,
  resolveTsc,
  runTsc,
  sourceFiles,
  tscVersion,
  withDeprecatedModules,
  writeProjectFile,
} from './extension-typecheck.mjs'
import { allFiles, describeTree } from './repo.mjs'

/** The core repository this package is part of. */
export const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const APP_ROOT = path.join(CORE_ROOT, 'apps', 'opencroft')
const WORK_DIR = path.join(APP_ROOT, '.opencroft-dev')

const fail = (reason) => {
  console.error(`opencroft-dev typecheck: ${reason}`)
  console.error('Nothing is being reported as clean: this is a failure of the check, not a verdict on the code.')
  return 2
}

const isInside = (child, parent) => child.startsWith(`${parent}${path.sep}`)

const hashOf = (...parts) => {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part ?? '')
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/** Remove from `dir` every file and directory not in `keep` (relative paths), sparing node_modules. */
function prune(dir, keep, rel = '') {
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (!rel && entry.name === 'node_modules') {
      continue
    }
    if (entry.isDirectory()) {
      prune(dir, keep, relPath)
      if (readdirSync(path.join(dir, relPath)).length === 0) {
        rmSync(path.join(dir, relPath), { recursive: true })
      }
    } else if (!keep.has(relPath)) {
      rmSync(path.join(dir, relPath))
    }
  }
}

/** Copy the checkout into the core tree and install its own dependencies there. Returns the copy's path. */
function stage(root, files) {
  const manifest = path.join(root, 'package.json')
  const declaredName = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).name : null
  const name = String(declaredName || path.basename(root)).replace(/[^a-zA-Z0-9._-]/g, '-')
  const dest = path.join(WORK_DIR, 'extensions', `${name}-${hashOf(root).slice(0, 8)}`)
  mkdirSync(dest, { recursive: true })
  const keep = new Set(files.filter((file) => !file.startsWith('node_modules/')))
  for (const file of keep) {
    const target = path.join(dest, file)
    mkdirSync(path.dirname(target), { recursive: true })
    cpSync(path.join(root, file), target)
  }
  prune(dest, keep)

  const read = (file) => (existsSync(path.join(dest, file)) ? readFileSync(path.join(dest, file), 'utf8') : null)
  const lock = read('package-lock.json')
  const stamp = hashOf(read('package.json'), lock)
  const stampFile = path.join(dest, 'node_modules', '.opencroft-dev-deps')
  const current = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : null
  if (current !== stamp) {
    console.log(`  installing the copy's dependencies (${lock ? 'npm ci' : 'npm install'})…`)
    const args = lock
      ? ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--no-package-lock']
    const install = spawnSync('npm', args, { cwd: dest, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (install.status !== 0) {
      throw new Error(
        `npm ${args[0]} failed in the staged copy:\n${install.stderr.trim().split('\n').slice(-10).join('\n')}`,
      )
    }
    mkdirSync(path.dirname(stampFile), { recursive: true })
    writeFileSync(stampFile, stamp)
  }
  return dest
}

/** The core repository: its own `typecheck` script, which runs every workspace's. */
function typecheckCore(root) {
  console.log('── opencroft-dev typecheck ─────────────────────────────────────')
  console.log(`  commit    ${describeTree(root)}`)
  console.log('  runs      npm run typecheck (every workspace)')
  console.log('────────────────────────────────────────────────────────────────')
  const run = spawnSync('npm', ['run', 'typecheck'], { cwd: root, stdio: 'inherit' })
  if (run.error) {
    return fail(`could not run npm: ${run.error.message}`)
  }
  if (run.status === null) {
    return fail(`npm run typecheck was stopped by ${run.signal} before it finished`)
  }
  return run.status === 0 ? 0 : 1
}

/** Returns the process exit code: 0 clean, 1 type errors, 2 the check itself failed. */
export function typecheck(root) {
  if (root === CORE_ROOT) {
    return typecheckCore(root)
  }
  if (!existsSync(path.join(APP_ROOT, 'package.json'))) {
    return fail(`${CORE_ROOT} is not an OpenCroft core tree, so there is no host to typecheck against`)
  }

  const inPlace = isInside(root, APP_ROOT)
  console.log('── opencroft-dev typecheck ─────────────────────────────────────')
  console.log(`  commit    ${describeTree(root)}`)
  console.log(`  host      ${CORE_ROOT} at ${describeTree(CORE_ROOT)}`)
  let dir
  try {
    dir = inPlace ? root : stage(root, allFiles(root))
  } catch (err) {
    return fail(err.message)
  }
  console.log(`  checked   ${inPlace ? 'in place' : `as a copy at ${path.relative(CORE_ROOT, dir)}`}`)

  const tsc = resolveTsc(dir)
  if (!tsc) {
    return fail('no tsc in the core tree, run `npm ci` there')
  }
  console.log(`  tsc       ${tscVersion(tsc)}`)

  const files = sourceFiles(dir)
  if (files.length === 0) {
    return fail('the repository has no .ts or .tsx file, so there is nothing a typecheck could say about it')
  }
  // The repository's own check project when it declares one (which files, which
  // ambient types); otherwise the same project the instance-wide check writes.
  const projects = path.join(WORK_DIR, 'projects')
  mkdirSync(projects, { recursive: true })
  const slug = path.basename(dir)
  const declared = path.join(dir, 'tsconfig.check.json')
  // A generated project already carries the deprecated `@ext/*` declarations;
  // a repository's own is given them too.
  const project = existsSync(declared)
    ? withDeprecatedModules(tsc, declared, slug, projects)
    : writeProjectFile(slug, dir, projects)
  const deprecated = filesOnDeprecatedSpecifiers(files)

  const { own, foreign, unparsed, status } = runTsc(tsc, project, dir)
  console.log(`  project   ${existsSync(declared) ? 'tsconfig.check.json' : 'generated (extends tsconfig.json)'}`)
  console.log(`  scanned   ${files.length} source files, ${own.length} type error(s)`)
  if (deprecated.length > 0) {
    console.log(
      `  deprecated ${deprecated.length} file(s) import @ext/host or @ext/ui; each name's replacement in @opencroft/client / @opencroft/server is in its deprecation`,
    )
  }
  if (foreign.length > 0) {
    console.log(`  ignored   ${foreign.length} diagnostic(s) against host packages, caught by that package's own run`)
  }
  if (unparsed.length > 0) {
    return fail(`unrecognized tsc output:\n${unparsed.join('\n')}`)
  }
  // A non-zero tsc with nothing parseable means the run itself failed (a bad
  // project, a missing binary) and must not read as a clean pass.
  if (status !== 0 && own.length + foreign.length === 0) {
    return fail(`tsc exited ${status} with no diagnostic to show for it`)
  }
  console.log(`  verdict   ${own.length > 0 ? 'FAIL' : 'PASS'}`)
  console.log('────────────────────────────────────────────────────────────────')
  for (const { file, line, message } of own) {
    console.log(`  ${file}:${line}  ${message}`)
  }
  return own.length > 0 ? 1 : 0
}
