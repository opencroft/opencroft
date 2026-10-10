// Typechecks the extension checkouts under this instance's data dir, which
// nothing else does.
//
// An extension is its own repository, cloned into a folder of the extensions
// root and built by esbuild. esbuild strips types without checking them, so a
// successful compile says the file parsed and bundled -- never that it
// typechecks. Biome does not reach these paths either. This script is the only
// thing that reads them with a type checker.
//
// Only the `local.*` folders are read: they are the editable ones, and the
// ones whose type errors this repository's authors can fix. Every other folder
// is a snapshot of a registry release, which an update replaces.
//
// An extension is `checked` (tsc ran over it) or `empty` (no source files),
// and empty is reported as itself rather than as a pass -- a check whose
// success condition is "nothing failed" reports success hardest when it looked
// at nothing. Files still on the deprecated `@ext/*` modules are checked
// against those modules' declarations and counted per extension, which names
// which repository has migrating left to do.
//
// Every diagnostic fails the run: nothing is tolerated.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  filesOnDeprecatedSpecifiers,
  resolveTsc,
  runTsc,
  sourceFiles,
  writeProjectFile,
} from '@opencroft/dev-tools/extension-typecheck'

// npm runs a workspace script from the workspace directory.
const APP_ROOT = process.cwd()
// The one extensions root, resolved the way `dataDir` in @opencroft/instance does.
const EXTENSION_ROOT = path.join(process.env.OPENCROFT_DATA_DIR || path.join(APP_ROOT, 'data'), 'extensions')
// `isLocalFolder` in app/_authed/(extension-runtime)/_extension-id.ts, restated
// because this file runs under plain node and cannot import that TypeScript;
// typecheck-extensions.test.ts holds the two to the same answer.
const LOCAL_FOLDER = /^local\.[a-z0-9-]+$/
const GENERATED_DIR = path.join(APP_ROOT, '.extension-typecheck')

function extensionDirectories() {
  if (!existsSync(EXTENSION_ROOT)) {
    return []
  }
  return readdirSync(EXTENSION_ROOT)
    .filter((name) => LOCAL_FOLDER.test(name))
    .map((name) => ({ slug: name, dir: path.join(EXTENSION_ROOT, name) }))
    .filter((entry) => statSync(entry.dir).isDirectory())
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

function inspect(tsc, { slug, dir }) {
  const files = sourceFiles(dir)
  if (files.length === 0) {
    return { slug, state: 'empty', files: 0 }
  }
  const deprecated = filesOnDeprecatedSpecifiers(files).length
  const { own, foreign, unparsed, status } = runTsc(tsc, writeProjectFile(slug, dir, GENERATED_DIR), dir)
  const signatures = own.map(({ file, line, message }) => `${file}:${line}: ${message}`)
  return { slug, state: 'checked', files: files.length, deprecated, own: signatures, foreign, unparsed, status }
}

function describe(report) {
  if (report.state === 'empty') {
    return 'no source files'
  }
  const onDeprecated = report.deprecated > 0 ? `, ${report.deprecated} on @ext/*` : ''
  if (report.own.length === 0) {
    return `${report.files} files${onDeprecated}, clean`
  }
  return `${report.files} files${onDeprecated}, ${report.own.length} diagnostic(s)`
}

const directories = extensionDirectories()
if (directories.length === 0) {
  // Not a pass. A checkout with no extensions in it is the ordinary state of a
  // fresh clone, and reporting "OK" there would say this app's extensions are
  // typechecked when nothing was read.
  console.log(`No local.* extension folders under ${EXTENSION_ROOT} -- 0 extensions typechecked.`)
  process.exit(0)
}

const tsc = resolveTsc(APP_ROOT)
if (!tsc) {
  console.log('No local tsc found -- refusing to report a result no checker produced.')
  process.exit(1)
}

rmSync(GENERATED_DIR, { recursive: true, force: true })
mkdirSync(GENERATED_DIR, { recursive: true })

const version = spawnSync(tsc, ['--version'], { encoding: 'utf8' }).stdout?.trim()
console.log(`${version} over ${EXTENSION_ROOT}`)

const reports = directories.map((entry) => inspect(tsc, entry))
for (const report of reports) {
  console.log(`  ${report.slug.padEnd(20)} ${describe(report)}`)
}

const checked = reports.filter((report) => report.state === 'checked')
console.log(`extensions: ${reports.length} found, ${checked.length} typechecked`)

const foreignCount = checked.reduce((sum, report) => sum + report.foreign.length, 0)
if (foreignCount > 0) {
  console.log(`${foreignCount} diagnostic(s) against host packages ignored -- caught by that package's own run.`)
}

const unparsed = checked.flatMap((report) => report.unparsed)
if (unparsed.length > 0) {
  console.log('Unrecognized tsc output (treated as a failure):')
  console.log(unparsed.join('\n'))
  process.exit(1)
}

// A non-zero tsc with nothing parseable means the run itself failed -- a bad
// generated project, a missing binary -- and must not read as a clean pass.
const brokenRun = checked.find((report) => report.status !== 0 && report.own.length + report.foreign.length === 0)
if (brokenRun) {
  console.log(`tsc exited ${brokenRun.status} for ${brokenRun.slug} with no diagnostic to show for it.`)
  process.exit(1)
}

const diagnostics = checked.flatMap((report) => report.own.map((signature) => `${report.slug}/${signature}`))
if (diagnostics.length > 0) {
  console.log(`${diagnostics.length} diagnostic(s):`)
  console.log(diagnostics.map((id) => `  ${id}`).join('\n'))
  process.exit(1)
}
