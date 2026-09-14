// Typechecks the extension checkouts beside this app, which nothing else does.
//
// An extension is its own repository, cloned under the local-extension root and
// built by esbuild. esbuild strips types without checking them, so a successful
// compile says the file parsed and bundled -- never that it typechecks. Biome
// does not reach these paths either. This script is the only thing that reads
// them with a type checker.
//
// THREE ANSWERS, NOT TWO. An extension is `checked` (tsc ran over it),
// `blocked` (it imports a specifier that has no declarations, so tsc would
// report the cascade from an unresolved module rather than anything about the
// code), or `empty` (no source files). Blocked and empty are reported as
// themselves rather than as a pass -- a check whose success condition is
// "nothing failed" reports success hardest when it looked at nothing.
//
// The blocked count is also the only measure of how far the migration onto the
// declared spellings has got, so it is printed per extension rather than
// summed: it names which repository is next and how many files stand in the way.
//
// Known diagnostics live in extension-typecheck-baseline.json, which is
// committed and never written by this script -- same contract, and the same
// reason, as test-baseline.json beside it: tolerating a failure stays possible
// and stops being free.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// npm runs a workspace script from the workspace directory.
const APP_ROOT = process.cwd()
const EXTENSION_ROOT = process.env.OPENCROFT_LOCAL_EXTENSIONS ?? path.join(APP_ROOT, 'data', 'extensions', 'local')
const GENERATED_DIR = path.join(APP_ROOT, '.extension-typecheck')
const BASELINE_PATH = path.join(APP_ROOT, 'extension-typecheck-baseline.json')

// The specifiers an extension can import that the compiler resolves at build
// time and no package declares. They are not an oversight: `@opencroft/client`
// and `@opencroft/server` are the declared contract, and these retire as
// extensions move onto it. A file importing one cannot be typechecked at all --
// an unresolved module makes every value from it `any`, which in a component
// file turns into hundreds of implicit-any diagnostics about nothing.
const UNDECLARED_SPECIFIERS = /['"]@ext\/(host|ui)['"]/

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git'])

/**
 * The checker, resolved to a path rather than left to `npx tsc`.
 *
 * `npx` with no local install does not fail: it fetches an unrelated registry
 * package of that name and runs it, which for a checker means no diagnostics
 * and exit 0 -- a clean report from something that never read the code. The
 * whole output of this script is an absence, so it has to carry positive proof
 * of what produced it. Hence the path, and hence the version printed beside the
 * results.
 */
function resolveTsc() {
  let dir = APP_ROOT
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsc')
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

/** Every TypeScript source file in a checkout, ignoring dependencies and build output. */
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // `dist.building-<pid>-<n>` is a compile's staging directory, a sibling
      // of dist/ that exists only while a build runs -- or forever, after one
      // was killed. It holds a copy of the output, never authored source.
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('dist.building-')) {
        continue
      }
      found.push(...sourceFiles(path.join(dir, entry.name)))
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(path.join(dir, entry.name))
    }
  }
  return found
}

function filesOnUndeclaredSpecifiers(files) {
  return files.filter((file) => UNDECLARED_SPECIFIERS.test(readFileSync(file, 'utf8')))
}

/**
 * The tsconfig the check runs with, written inside this app rather than inside
 * the extension: a checkout is a separate repository, and on a deployed
 * instance it is shared, so this must not put a file in one.
 *
 * It extends the extension's own tsconfig when there is one, so a repository
 * keeps its path aliases, and pins the options the check itself depends on.
 * `baseUrl` is the checkout, which is what makes an inherited relative `paths`
 * entry resolve against the repository that wrote it.
 */
function writeProjectFile(slug, dir) {
  const own = path.join(dir, 'tsconfig.json')
  const project = {
    ...(existsSync(own) ? { extends: own } : {}),
    compilerOptions: {
      target: 'ES2022',
      lib: ['dom', 'dom.iterable', 'esnext'],
      module: 'esnext',
      moduleResolution: 'bundler',
      jsx: 'preserve',
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      isolatedModules: true,
      skipLibCheck: true,
      // `vite/client` declares the CSS-module imports the host packages make;
      // without it every one of those is reported against a host package that
      // typechecks fine on its own.
      types: ['node', 'vite/client'],
      baseUrl: dir,
    },
    include: [path.join(dir, '**/*.ts'), path.join(dir, '**/*.tsx')],
    exclude: [path.join(dir, 'node_modules'), path.join(dir, 'dist')],
  }
  const file = path.join(GENERATED_DIR, `${slug}.json`)
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`)
  return file
}

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): (error TS\d+: .*)$/

/**
 * Run tsc and split what it says into this extension's diagnostics and the rest.
 *
 * A diagnostic against a host package is that package's own business -- it
 * typechecks itself, and its source is only in this program because an
 * extension imports it. Counted and dropped rather than silently ignored, the
 * same rule run-typecheck.mjs follows for the same reason.
 *
 * Line and column are stripped from the signature so an edit above a known
 * diagnostic does not read as a new one.
 */
function runTsc(tsc, projectFile, dir) {
  const result = spawnSync(tsc, ['--noEmit', '-p', projectFile], { encoding: 'utf8' })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const own = []
  const foreign = []
  const unparsed = []
  for (const line of output.split('\n').filter((value) => value.length > 0)) {
    const match = line.match(DIAGNOSTIC)
    if (match) {
      const [, file, rest] = match
      const absolute = path.resolve(APP_ROOT, file)
      const target = absolute.startsWith(`${dir}${path.sep}`) ? own : foreign
      target.push(`${path.relative(dir, absolute)}: ${rest}`)
      continue
    }
    // tsc wraps a diagnostic's detail on indented continuation lines with no
    // position of their own; they belong to the diagnostic above them.
    if (/^\s/.test(line)) {
      continue
    }
    unparsed.push(line)
  }
  return { own, foreign, unparsed, status: result.status }
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return new Map()
  }
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  return new Map((parsed.tolerated ?? []).map((entry) => [entry.id, entry]))
}

function extensionDirectories() {
  if (!existsSync(EXTENSION_ROOT)) {
    return []
  }
  return readdirSync(EXTENSION_ROOT)
    .map((name) => ({ slug: name, dir: path.join(EXTENSION_ROOT, name) }))
    .filter((entry) => statSync(entry.dir).isDirectory())
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

function inspect(tsc, { slug, dir }) {
  const files = sourceFiles(dir)
  if (files.length === 0) {
    return { slug, state: 'empty', files: 0 }
  }
  const undeclared = filesOnUndeclaredSpecifiers(files)
  if (undeclared.length > 0) {
    return { slug, state: 'blocked', files: files.length, undeclared: undeclared.length }
  }
  const { own, foreign, unparsed, status } = runTsc(tsc, writeProjectFile(slug, dir), dir)
  return { slug, state: 'checked', files: files.length, own, foreign, unparsed, status }
}

function describe(report) {
  if (report.state === 'empty') {
    return 'no source files'
  }
  if (report.state === 'blocked') {
    return `blocked -- ${report.undeclared} of ${report.files} files import a specifier with no declarations`
  }
  if (report.own.length === 0) {
    return `${report.files} files, clean`
  }
  return `${report.files} files, ${report.own.length} diagnostic(s)`
}

const directories = extensionDirectories()
if (directories.length === 0) {
  // Not a pass. A checkout with no extensions in it is the ordinary state of a
  // fresh clone, and reporting "OK" there would say this app's extensions are
  // typechecked when nothing was read.
  console.log(`No extension checkouts under ${EXTENSION_ROOT} -- 0 extensions typechecked.`)
  process.exit(0)
}

const tsc = resolveTsc()
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
const blocked = reports.filter((report) => report.state === 'blocked')
console.log(
  `extensions: ${reports.length} found, ${checked.length} typechecked, ${blocked.length} blocked on undeclared specifiers`,
)

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

// Counted rather than collected into a set. Stripping line and column is what
// keeps an edit above a diagnostic from reading as a new one, and it also makes
// two diagnostics of the same shape in the same file share one signature -- so
// a set would go on matching the baseline after one of a pair was fixed, and
// again after a third appeared. The count is what tells those apart.
const baseline = readBaseline()
const counts = new Map()
for (const report of checked) {
  for (const signature of report.own) {
    const id = `${report.slug}/${signature}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
}

const tolerated = (id) => baseline.get(id)?.count ?? (baseline.has(id) ? 1 : 0)
const added = [...counts]
  .filter(([id, count]) => count > tolerated(id))
  .map(([id, count]) => (count > 1 ? `${id}  [${count} occurrences, ${tolerated(id)} tolerated]` : id))
const stale = [...baseline.keys()].filter((id) => (counts.get(id) ?? 0) < tolerated(id))

if (stale.length > 0) {
  console.log(`${stale.length} baseline entries no longer reproduce -- remove them from the baseline:`)
  console.log(stale.map((id) => `  ${id}`).join('\n'))
}

if (added.length > 0) {
  console.log(`${added.length} new diagnostic(s):`)
  console.log(added.map((id) => `  ${id}`).join('\n'))
  process.exit(1)
}

const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
if (total > 0) {
  console.log(`${total} known diagnostic(s), no new ones. See ${path.basename(BASELINE_PATH)}.`)
}
