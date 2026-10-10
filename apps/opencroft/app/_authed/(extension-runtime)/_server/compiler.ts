import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

import { compile as compileTailwind } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import * as esbuild from 'esbuild'
import * as lucideIcons from 'lucide-react'

import { readCheckoutState } from '@/app/_authed/(extension-runtime)/_server/checkout-state'
import { EXTENSION_UTILITY_LAYER, hasVariant } from '@/app/_authed/(extension-runtime)/_server/css-cascade-layers'
import { deprecationWarning, logDeprecations } from '@/app/_authed/(extension-runtime)/_server/deprecations'
import { scanDeprecatedApiUses } from '@/app/_authed/(extension-runtime)/_server/extension-api-deprecations'
import { hostVirtualPlugin } from '@/app/_authed/(extension-runtime)/_server/host-shims'
import { scanDeprecatedManifestKeys } from '@/app/_authed/(extension-runtime)/_server/manifest-key-deprecations'
import {
  BUILD_PROVENANCE_FILE,
  CLIENT_ICONS_FILE,
  extDir,
  extDistDir,
  isStagingName,
  projectRoot,
  stagingName,
} from '@/app/_authed/(extension-runtime)/_server/paths'
import { recordBundleDeclares } from '@/app/_authed/(extension-runtime)/_server/provided-points'
import type { BuildResult, CompileError, ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

// Resolve bundled (client) dependencies from every ancestor node_modules, so
// monorepo-hoisted packages (lucide-react, clsx, tailwind-merge, …) are found
// even when the app runs with its cwd set to a workspace subdir rather than the
// repo root — npm hoists shared deps up to the workspace root.
function ancestorNodeModules(start: string): string[] {
  const dirs: string[] = []
  let dir = start
  while (true) {
    dirs.push(path.join(dir, 'node_modules'))
    const parent = path.dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return dirs
}

const PROJECT_NODE_MODULES = ancestorNodeModules(projectRoot())

const execFileAsync = promisify(execFile)

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Where one build reads its sources and writes its output, and the extension id
 * the bundle is built for. Usually the folder serving that id (`locationOf`);
 * an install builds a staged copy before it is moved into place.
 */
export interface BuildLocation {
  extensionId: string
  sourceDir: string
  distDir: string
}

export function locationOf(extensionId: string): BuildLocation {
  return { extensionId, sourceDir: extDir(extensionId), distDir: extDistDir(extensionId) }
}

const SERVER_EXTERNAL_PACKAGES = [
  'node:*',
  'fs',
  'path',
  'os',
  'child_process',
  'crypto',
  'stream',
  'util',
  'events',
  'ssh2',
]

// Workspace packages that ship TypeScript source (no built JS) must be bundled
// into the extension, never externalized — Node cannot `require` their `.ts` entry.
const ALWAYS_BUNDLED_PACKAGES = ['@opencroft/core', '@opencroft/client', '@opencroft/server']

function toCompileErrors(messages: esbuild.Message[]): CompileError[] {
  return messages.map((m) => ({
    file: m.location?.file ?? '(unknown)',
    line: m.location?.line,
    column: m.location?.column,
    message: m.text,
  }))
}

// Resolves each declared specifier to an empty module instead of letting
// esbuild bundle whatever it really points at. For a dependency's own
// internal, runtime-gated branch (an `if` esbuild can't prove dead) that this
// extension never reaches — see ExtensionManifest.clientStubs for the full
// contract. `matched` is populated as specifiers are actually resolved during
// the build, so the caller can tell a declared-and-used stub from a
// declared-but-never-imported one after the build finishes.
//
// An empty module (not `external`) on purpose: a browser ESM bundle has no
// runtime module resolver, so leaving a bare specifier unresolved in the
// output would be a hard resolution error if the "dead" branch were ever
// actually reached. Resolving to real, empty code instead means that same
// mistake surfaces as a TypeError from calling something on `undefined` —
// still a bug, but a debuggable one at the call site instead of a blank
// browser tab.
function clientStubPlugin(specifiers: string[], matched: Set<string>): esbuild.Plugin {
  const declared = new Set(specifiers)
  return {
    name: 'ext-client-stub',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!declared.has(args.path)) {
          return null
        }
        matched.add(args.path)
        return { path: args.path, namespace: 'ext-client-stub' }
      })
      build.onLoad({ filter: /.*/, namespace: 'ext-client-stub' }, () => ({
        contents: 'export {}\n',
        loader: 'js',
      }))
    },
  }
}

// Real icon exports, computed once from the actual package rather than
// hand-kept, so this can never drift from what `icons.<Name>` really
// resolves to at runtime. A small, fixed set of names on the same namespace
// are TypeScript types with no runtime binding (`icon: icons.LucideIcon` in
// a prop type, not a component) -- real, correct, existing code, and not
// what this check exists to catch.
const ICON_NAMES = new Set(Object.keys(lucideIcons))
const ICON_NAMESPACE_TYPE_EXPORTS = new Set(['LucideIcon', 'LucideProps', 'IconNode'])
// Named in the error for an unknown icon: a name that is real on lucide.dev but
// newer than the host's copy reads exactly like a typo otherwise.
const ICON_PACKAGE_VERSION: string = createRequire(import.meta.url)('lucide-react/package.json').version

interface IconNameViolation {
  file: string
  name: string
}

interface IconUsage {
  /** Every real icon name the sources name, for the browser to preload. */
  used: string[]
  violations: IconNameViolation[]
}

// Reads the icon names an extension's client sources name: `icons.<Name>`
// member access, names destructured out of `icons`, and names imported from
// `lucide-react` (which the client build resolves to the host's icon set, so
// esbuild cannot tell a misspelt one apart any more). A real name is recorded
// for the browser to preload; one that isn't a real export of the icon
// package is a violation -- an icon name that only ever arrives as data,
// rather than being written into source, can't be seen here (see
// safe-icons.ts on the app side for that half).
//
// A regex scan over source text, not an AST walk: the same mechanical,
// good-enough approach the workspace-dependency check already uses elsewhere
// in this codebase, chosen for the same reason -- it is
// simple to read, simple to trust, and the failure mode of a false positive
// (an unnecessary build error) is far cheaper than the crash this exists to
// prevent, so a little imprecision is an acceptable trade.
//
// A standalone post-build scan over the metafile's own input list, not an
// esbuild plugin hooked into onLoad -- an onLoad callback runs DURING the
// build, reading the same files esbuild's own loader is reading at the same
// time. That doubled, independent read is exactly what turned a source edit
// landing mid-build (already exercised deliberately by build-race.test.ts)
// into a torn read and a real build failure — confirmed directly by running
// that test with and without this function wired in as a plugin. Reading
// once, after the build has already settled on what it bundled, has no such
// interaction with esbuild's own file access.
async function scanIconUsage(src: string, metafile: esbuild.Metafile): Promise<IconUsage> {
  const MEMBER_RE = /\bicons\.([A-Za-z_$][\w$]*)/g
  const DESTRUCTURE_RE = /\{([^{}]*)\}\s*=\s*icons\b/g
  // `import type { … }` is erased and binds nothing at runtime, so it is left out.
  const IMPORT_RE = /\bimport\s*\{([^{}]*)\}\s*from\s*['"]lucide-react['"]/g
  const used = new Set<string>()
  const violations: IconNameViolation[] = []
  const record = (file: string, name: string) => {
    if (ICON_NAMES.has(name)) {
      used.add(name)
    } else if (!ICON_NAMESPACE_TYPE_EXPORTS.has(name)) {
      violations.push({ file, name })
    }
  }
  for (const relPath of Object.keys(metafile.inputs)) {
    if (!/\.[jt]sx?$/.test(relPath) || relPath.includes('node_modules')) {
      continue
    }
    const source = await fs.readFile(path.resolve(src, relPath), 'utf-8').catch(() => null)
    if (source === null) {
      continue
    }
    for (const match of source.matchAll(MEMBER_RE)) {
      record(relPath, match[1])
    }
    for (const match of source.matchAll(DESTRUCTURE_RE)) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(':')[0].trim()
        if (name && !name.startsWith('...')) {
          record(relPath, name)
        }
      }
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      for (const raw of match[1].split(',')) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]
          .trim()
        if (name && !name.startsWith('type ')) {
          record(relPath, name)
        }
      }
    }
  }
  return { used: [...used].sort(), violations }
}

async function readDependencyNames(sourceDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(sourceDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    return Object.keys(pkg.dependencies ?? {})
  } catch {
    return []
  }
}

/**
 * The entry points each side compiles from, in priority order (`manifest.main`
 * overrides the server list). Exported so the loader's freshness check can ask
 * the same question the compiler answers: which bundles CAN this extension
 * have. A side with no entry produces no bundle, so requiring one would wait
 * for a file that can never exist.
 */
export const SERVER_ENTRY_CANDIDATES = ['server/index.ts', 'server/index.tsx', 'extension.ts', 'extension.tsx']
export const CLIENT_ENTRY_CANDIDATES = ['src/client.tsx', 'src/client.ts', 'src/index.tsx', 'src/index.ts']

async function pickEntry(dir: string, candidates: string[]): Promise<string | null> {
  for (const name of candidates) {
    const file = path.join(dir, name)
    try {
      await fs.access(file)
      return file
    } catch {
      // try next
    }
  }
  return null
}

const SOURCE_MAP_MARKER = '//# sourceMappingURL='

// Distinguishes concurrent rewrites within one process; the pid distinguishes
// them across processes. See versionSourceMapLink for why both are needed.
let rewriteCount = 0

// esbuild links the map as a bare `client.js.map`, which a browser resolves
// against the bundle's own request URL — dropping the `?v=` that makes these
// artifacts safe to serve immutably. The map would then be cached for a year
// under a URL that never changes, and a rebuilt extension would be debugged
// against the previous build's sources.
//
// So stamp the link with a version of its own. It is the MAP's mtime, not the
// bundle's: rewriting the bundle here changes the bundle's mtime, and keying
// off that would invalidate the value in the act of writing it.
export async function versionSourceMapLink(
  outfile: string,
  publicMapName = path.basename(`${outfile}.map`),
): Promise<void> {
  const mapFile = `${outfile}.map`
  let version: number
  try {
    version = Math.floor((await fs.stat(mapFile)).mtimeMs)
  } catch {
    // No map on disk (a failed build writes nothing) — leave the bundle alone.
    return
  }
  const code = await fs.readFile(outfile, 'utf-8')
  const at = code.lastIndexOf(SOURCE_MAP_MARKER)
  if (at < 0) {
    return
  }
  // publicMapName defaults to this file's own basename, but a caller building
  // under a temporary name (see compileSide) must pass the name the map will
  // actually be published under — the browser never sees the temp name, so a
  // link to it would 404 forever.
  const linked = `${code.slice(0, at)}${SOURCE_MAP_MARKER}${publicMapName}?v=${version}\n`
  // Write-then-rename rather than writing over the bundle in place. The route
  // that serves these can be reading the file while this runs — an extension is
  // rebuilt on the first request after a restart, which is exactly when several
  // requests arrive at once — and a partial read of a multi-megabyte bundle
  // reaches the browser as `SyntaxError: Unexpected end of input`, killing the
  // extension until the next reload. Rename is atomic within a filesystem, so a
  // concurrent reader sees either the old bundle or the new one, never half of
  // one. The temp file sits beside the target to keep it on the same device.
  // Unique per REWRITE, not per process. buildExtension dedupes concurrent
  // builds of the same extension, but this function takes a bare file path and
  // has no idea whether its caller did — it has to stay safe called directly,
  // so two requests for the same extension can still be rewriting this bundle
  // at once as far as this function is concerned. A per-process name would
  // have them share one temp file: writer A renames it into place while
  // writer B is still filling it, promoting a half-written bundle atomically.
  // Atomic and truncated is worse than neither.
  rewriteCount += 1
  const temp = `${outfile}.${process.pid}.${rewriteCount}.tmp`
  try {
    await fs.writeFile(temp, linked)
    await fs.rename(temp, outfile)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

let buildAttemptCounter = 0

// A chunk's name IS its version — content-hashed, so different content is a
// different file by construction. Nothing referencing an old chunk is ever
// pointed at new content, and nothing needs a `?v=` the way the entry does.
// Chunks pile up across rebuilds anyway (esbuild has no idea which ones a
// previous build produced), so old ones are pruned once nothing published in
// the last hour could still be an in-flight browser's only copy of one — a
// tab that loaded an old `client.js` and only later takes the code path that
// dynamically imports one of its chunks must still find it.
const CHUNK_RETENTION_MS = 60 * 60 * 1000

async function pruneOrphanChunks(outDir: string, justPublished: Set<string>): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(outDir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith('chunk-') || justPublished.has(name)) {
      continue
    }
    const file = path.join(outDir, name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat && now - stat.mtimeMs > CHUNK_RETENTION_MS) {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }
}

// Publishes a split client build from its staging directory into `outDir`.
//
// Splitting means there is no longer one file to swap into place — an entry
// can import several chunks, and a chunk can import another. A reader must
// never see an entry (under its final, requestable name) that references a
// chunk that isn't at ITS final name yet: that is a transient 404 for
// whichever browser's request lands in the gap. Publishing every non-entry
// file first, entry last, makes that impossible — by the time the entry
// becomes visible under `client.js`, everything it can reach already is.
// Order among the non-entry files themselves doesn't matter: none of them is
// reachable under a name anything has requested yet, so there is no reader
// to protect until the entry itself is renamed.
//
// Chunk filenames are content-hashed by esbuild (`chunkNames: 'chunk-[hash]'`)
// and never reused, so publishing them is a plain rename to the SAME name —
// nothing to version, nothing that can collide with a previous build's chunk.
async function publishClientBuild(stagingDir: string, outDir: string): Promise<void> {
  const staged = await fs.readdir(stagingDir)
  const nonEntry = staged.filter((name) => name !== 'client.js' && name !== 'client.js.map')
  for (const name of nonEntry) {
    await fs.rename(path.join(stagingDir, name), path.join(outDir, name))
  }
  await fs.rename(path.join(stagingDir, 'client.js.map'), path.join(outDir, 'client.js.map')).catch(() => {})
  await fs.rename(path.join(stagingDir, 'client.js'), path.join(outDir, 'client.js'))
  await fs.rmdir(stagingDir).catch(() => {})
  await pruneOrphanChunks(outDir, new Set(nonEntry))
}

/** One side's build: its errors and warnings, and the source files it bundled (relative to the extension). */
interface SideResult {
  errors: CompileError[]
  warnings: CompileError[]
  sources: string[]
}

const NOTHING_BUILT: SideResult = { errors: [], warnings: [], sources: [] }

async function compileServerSide(location: BuildLocation, manifest: ExtensionManifest): Promise<SideResult> {
  const src = location.sourceDir
  const outDir = location.distDir
  await fs.mkdir(outDir, { recursive: true })

  const entry = manifest.main ? path.join(src, manifest.main) : await pickEntry(src, SERVER_ENTRY_CANDIDATES)
  if (!entry) {
    return NOTHING_BUILT
  }

  const finalOutfile = path.join(outDir, 'server.js')
  // buildExtension's in-flight guard stops two builds of the same extension
  // from running at once, but a route serving the finished bundle reads
  // straight off disk with no idea a build is running at all — and esbuild's
  // own write to `outfile` is not atomic. Build under a name nothing serves,
  // then publish with a rename once the whole side is ready; rename is
  // atomic within a filesystem, so a concurrent reader always sees either the
  // old bundle or the new one, never a partial one. See stagingName.
  buildAttemptCounter += 1
  const stagingDir = stagingName(outDir, buildAttemptCounter)
  const outfile = path.join(stagingDir, 'server.js')

  // Server bundles must not inline the extension's own dependencies: native
  // modules (sharp, ffmpeg-static) break when bundled, and bundling JS that is
  // then run against a different copy of the same package in the app's
  // node_modules causes version/ABI clashes. Keep them as runtime requires,
  // resolved from the extension's node_modules by the loader.
  const serverExternals = [
    ...SERVER_EXTERNAL_PACKAGES,
    ...(await readDependencyNames(src)).filter((name) => !ALWAYS_BUNDLED_PACKAGES.includes(name)),
  ]

  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      outfile,
      // Server bundles are never sent over a network — the loader reads
      // server.js off disk and evaluates it with `new Function`, which gives
      // a linked map no base URL to resolve against, so an external one would
      // just lose stack traces for no saving. Kept inline instead.
      sourcemap: 'inline',
      // Evaluated in-process from disk, where readable stack traces are worth
      // more than the bytes minification saves.
      minify: false,
      jsx: 'automatic',
      plugins: [hostVirtualPlugin('server', location.extensionId)],
      external: serverExternals,
      // For the deprecation scan, read after the build has settled.
      metafile: true,
      logLevel: 'silent',
      write: true,
      absWorkingDir: src,
      nodePaths: [path.join(src, 'node_modules'), ...PROJECT_NODE_MODULES],
    })
    await fs.rename(outfile, finalOutfile).catch(() => {})
    return {
      errors: toCompileErrors(result.errors),
      warnings: toCompileErrors(result.warnings),
      sources: Object.keys(result.metafile?.inputs ?? {}),
    }
  } catch (err) {
    const buildErr = err as esbuild.BuildFailure
    return {
      errors: buildErr.errors ? toCompileErrors(buildErr.errors) : [{ file: entry, message: String(err) }],
      warnings: buildErr.warnings ? toCompileErrors(buildErr.warnings) : [],
      sources: [],
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function compileClientSide(location: BuildLocation, manifest: ExtensionManifest): Promise<SideResult> {
  const src = location.sourceDir
  const outDir = location.distDir
  await fs.mkdir(outDir, { recursive: true })

  const entry = await pickEntry(src, CLIENT_ENTRY_CANDIDATES)
  if (!entry) {
    return NOTHING_BUILT
  }

  // Splitting can emit any number of chunks alongside the entry, and none of
  // them may become visible under a served name before every file it
  // (transitively) needs is already there (see publishClientBuild).
  buildAttemptCounter += 1
  const stagingDir = stagingName(outDir, buildAttemptCounter)

  // Declaring nothing here must change nothing about the build: an empty
  // list means clientStubPlugin registers zero onResolve matches and every
  // import resolves exactly as it did before this option existed.
  const stubSpecifiers = manifest.clientStubs ?? []
  const matchedStubs = new Set<string>()

  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outdir: stagingDir,
      // esbuild names split output from the entry point's own basename by
      // default, which would vary with which of the candidate entries above
      // matched. Pinned so the file callers actually request is always
      // `client.js`, same as the single-file build this replaces.
      entryNames: 'client',
      // Content-hashed, never reused across builds — see publishClientBuild
      // and pruneOrphanChunks.
      chunkNames: 'chunk-[hash]',
      splitting: true,
      // Client bundles are downloaded by every browser that opens a space, and
      // an inline map is three quarters of what they weigh. Written alongside
      // instead, so the browser fetches it only when devtools ask for it.
      sourcemap: true,
      minify: true,
      jsx: 'automatic',
      plugins: [hostVirtualPlugin('client', location.extensionId), clientStubPlugin(stubSpecifiers, matchedStubs)],
      // For scanIconUsage below and the deprecation scan, read after the build
      // has settled — see scanIconUsage for why that must not happen during it.
      metafile: true,
      logLevel: 'silent',
      write: true,
      absWorkingDir: src,
      nodePaths: [path.join(src, 'node_modules'), ...PROJECT_NODE_MODULES],
    })
    // The link has to name what the map will be published as, not what it's
    // called right now — nobody ever requests the staging path.
    await versionSourceMapLink(path.join(stagingDir, 'client.js'), 'client.js.map')
    await publishClientBuild(stagingDir, outDir)
    // Read before the build reports success, so the first listing after a
    // recompile already knows where the new bundle is used.
    await recordBundleDeclares(outDir)
    // A declared stub that never matched an import is the same class of
    // mistake as a typo'd dependency name — reported as a build error rather
    // than silently doing nothing, so the extension author finds out from
    // the build instead of from a bundle that quietly stayed large.
    const unmatchedStubs = stubSpecifiers.filter((specifier) => !matchedStubs.has(specifier))
    const icons = result.metafile ? await scanIconUsage(src, result.metafile) : { used: [], violations: [] }
    await fs.writeFile(path.join(outDir, CLIENT_ICONS_FILE), JSON.stringify(icons.used))
    const iconViolations = icons.violations
    return {
      errors: [
        ...toCompileErrors(result.errors),
        ...unmatchedStubs.map((specifier) => ({
          file: 'extension.json',
          message: `clientStubs entry "${specifier}" never matched an import in the client build — remove it or fix the specifier.`,
        })),
        ...iconViolations.map((v) => ({
          file: v.file,
          message: `${v.name} is not an icon in the host's lucide-react ${ICON_PACKAGE_VERSION} — check the spelling, or whether the icon was added to Lucide after that version. At runtime it would draw a placeholder instead.`,
        })),
      ],
      warnings: toCompileErrors(result.warnings),
      sources: Object.keys(result.metafile?.inputs ?? {}),
    }
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    const buildErr = err as esbuild.BuildFailure
    return {
      errors: buildErr.errors ? toCompileErrors(buildErr.errors) : [{ file: entry, message: String(err) }],
      warnings: buildErr.warnings ? toCompileErrors(buildErr.warnings) : [],
      sources: [],
    }
  }
}

async function compileSide(
  location: BuildLocation,
  manifest: ExtensionManifest,
  side: 'client' | 'server',
): Promise<SideResult> {
  return side === 'client' ? compileClientSide(location, manifest) : compileServerSide(location, manifest)
}

// Extensions compile at runtime, long after the host CSS was built — so each
// extension gets its own Tailwind pass over its client sources. The entry
// references the host theme without re-emitting tokens or preflight.
//
// The stylesheet is built in two passes, one per cascade layer, because the
// utilities have to be split by RANK and a single Tailwind pass emits one
// layer. Why splitting by rank is the only correct answer, and why sheet order
// cannot supply it, is in css-cascade-layers.ts.
//
// The layer statement names `extension-utilities` last, and does so in both
// passes for the price of one line: a layer name the host's own statement does
// not mention is appended after the names they share, so the extension layer
// sorts last whichever sheet the browser parses first. That independence is the
// point — the previous arrangement was correct only while the injection order
// in _client/loader.ts stayed exactly as it was, and nothing said so there.
function extCssEntry(layer: string): string {
  return `
@layer theme, base, components, utilities, ${EXTENSION_UTILITY_LAYER};
@import 'tailwindcss/theme.css' theme(reference);
@import 'ui/theme.css' theme(reference);
@import 'tw-animate-css';
@import 'tailwindcss/utilities.css' layer(${layer});
`
}

/**
 * Compile one extension's stylesheet from the sources under `srcDir`: its plain
 * utilities into `utilities`, its variant-carrying ones into
 * `extension-utilities`.
 *
 * Exported for the test that asserts where each half lands. Nothing had ever
 * asserted anything about this artefact's content before — which is how the
 * same cascade collision reached a user through two different extensions.
 */
export async function buildExtensionCss(srcDir: string): Promise<string> {
  const scanner = new Scanner({ sources: [{ base: srcDir, pattern: '**/*', negated: false }] })
  const candidates = scanner.scan()
  const buildLayer = async (layer: string, subset: string[]): Promise<string> => {
    // An empty subset still emits the entry's own preamble, so skip the pass
    // rather than concatenate a second copy of it for no utilities.
    if (subset.length === 0) {
      return ''
    }
    const compiler = await compileTailwind(extCssEntry(layer), { base: projectRoot(), onDependency: () => {} })
    return compiler.build(subset)
  }
  const plain = await buildLayer(
    'utilities',
    candidates.filter((candidate) => !hasVariant(candidate)),
  )
  const variants = await buildLayer(
    EXTENSION_UTILITY_LAYER,
    candidates.filter((candidate) => hasVariant(candidate)),
  )
  return [plain, variants].filter(Boolean).join('\n')
}

async function compileClientCss(location: BuildLocation): Promise<CompileError[]> {
  const srcDir = path.join(location.sourceDir, 'src')
  const finalOutfile = path.join(location.distDir, 'client.css')
  // Same reasoning as compileSide's publish step: client.css is served by the
  // same route as client.js, and writing straight to the served path is not
  // atomic — a reader can catch it mid-write. Build to a staged name and rename
  // into place once ready.
  buildAttemptCounter += 1
  const stagingDir = stagingName(location.distDir, buildAttemptCounter)
  const outfile = path.join(stagingDir, 'client.css')
  try {
    const css = await buildExtensionCss(srcDir)
    await fs.mkdir(stagingDir, { recursive: true })
    await fs.writeFile(outfile, css)
    await fs.rename(outfile, finalOutfile)
    return []
  } catch (err) {
    return [{ file: 'client.css', message: String(err) }]
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Install an extension's npm dependencies on demand before building, so a
// source-only checkout (a freshly cloned extension with no node_modules)
// compiles without a manual install step. Behaviour:
//   - `npm ci` when a lockfile is present — deterministic, and it clears
//     node_modules itself; falls back to a clean `npm install` if the lockfile
//     is out of sync with package.json.
//   - `npm install` (no fabricated lockfile) when there is none.
// The install only re-runs when it needs to: a fingerprint of package.json +
// the lockfile is stored inside node_modules, so an unchanged manifest is a
// no-op, and a changed one reinstalls (clearing the stale tree) without any
// manual cleanup. --legacy-peer-deps keeps npm from resolving host-provided
// @opencroft/* peer deps, which are declared as peers but not published to npm
// (the host virtual plugin supplies them at build time).
//
// This is the one place an extension's dependencies are installed, and it runs
// inside the build slot, so no two installs ever share a node_modules. The
// marker is cleared before an install and written only after one succeeds, so
// an interrupted install never reads as complete.
async function ensureDependencies(dir: string): Promise<CompileError[]> {
  const pkgRaw = await readFileOrNull(path.join(dir, 'package.json'))
  if (!pkgRaw) {
    return []
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(pkgRaw)
  } catch {
    return []
  }
  const hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0
  if (!hasDeps) {
    return []
  }

  const nodeModules = path.join(dir, 'node_modules')
  const lockRaw = await readFileOrNull(path.join(dir, 'package-lock.json'))
  const fingerprint = createHash('sha256')
    .update(pkgRaw)
    .update('\0')
    .update(lockRaw ?? '')
    .digest('hex')
  const markerPath = path.join(nodeModules, '.opencroft-deps')
  if ((await readFileOrNull(markerPath))?.trim() === fingerprint) {
    // node_modules already matches the current manifest — nothing to do.
    return []
  }

  await fs.rm(markerPath, { force: true })
  const flags = ['--legacy-peer-deps', '--no-audit', '--no-fund', '--loglevel=error']
  const npm = (args: string[]) =>
    execFileAsync('npm', args, {
      cwd: dir,
      env: process.env,
      timeout: 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    })
  try {
    if (lockRaw) {
      try {
        await npm(['ci', ...flags])
      } catch {
        await fs.rm(nodeModules, { recursive: true, force: true })
        await npm(['install', '--no-package-lock', ...flags])
      }
    } else {
      await fs.rm(nodeModules, { recursive: true, force: true })
      await npm(['install', '--no-package-lock', ...flags])
    }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return [{ file: 'package.json', message: `npm install failed: ${e.stderr || e.message || String(err)}` }]
  }
  // Record the manifest fingerprint so the next build skips reinstalling.
  await fs.writeFile(markerPath, fingerprint).catch(() => {})
  return []
}

// Callers: ensureBuilt's mtime-triggered path (loader.ts), the dev-mode file
// watcher, and two explicit "rebuild" actions in the extension editor — none
// of them coordinate with each other. Without this, two of them landing on
// the same extension around the same time each run their own esbuild pass
// over the same output files. Deduplicating here, at the one function every
// caller funnels through, protects all of them at once — a guard placed
// only in ensureBuilt would miss the other three. Keyed by extension so
// unrelated extensions still build in parallel.
interface BuildSlot {
  running: Promise<BuildResult>
  // Set once, by whichever caller is first to arrive while `running` is still
  // in flight. Every later arrival gets handed this SAME promise rather than
  // each queuing its own — otherwise a build that finishes just before a
  // burst of late callers would let each of them kick off a redundant build
  // of their own instead of sharing the one already coalesced for them.
  next: Promise<BuildResult> | null
}

// Keyed by source directory: a folder is built by one build at a time, whatever
// id it is being built for.
const inFlightBuilds = new Map<string, BuildSlot>()

/** Build the folder serving `extensionId`. */
export function buildExtension(extensionId: string, manifest: ExtensionManifest): Promise<BuildResult> {
  return buildExtensionAt(locationOf(extensionId), manifest)
}

/** Build the sources at `location` into its `distDir`. */
export function buildExtensionAt(location: BuildLocation, manifest: ExtensionManifest): Promise<BuildResult> {
  const slot = inFlightBuilds.get(location.sourceDir)
  if (!slot) {
    return startBuild(location, manifest)
  }
  // A build for this extension is already running. Its result was read from
  // whatever the source looked like when IT started, which may already be
  // stale by the time this caller asked — handing this caller that build's
  // own result would silently drop an edit that landed in between, and the
  // atomic publish that just shipped makes that loss permanent: the
  // published bundle's mtime becomes newer than the edit, so the mtime check
  // that would otherwise have caught it never fires again. Queue exactly one
  // more build to run right after the current one settles (success or
  // failure — a late arrival wants a current answer regardless of how the
  // one already running turns out), and answer this caller from that.
  if (!slot.next) {
    slot.next = slot.running.then(
      () => startBuild(location, manifest),
      () => startBuild(location, manifest),
    )
  }
  return slot.next
}

function startBuild(location: BuildLocation, manifest: ExtensionManifest): Promise<BuildResult> {
  const running = buildExtensionNow(location, manifest)
  inFlightBuilds.set(location.sourceDir, { running, next: null })
  // `running` itself is returned below and handled by the caller. `.finally`
  // derives a NEW promise that adopts running's rejection, and nothing here
  // awaits or handles that derived one — left alone, a rejected build would
  // be an unhandled rejection on a promise nobody but this cleanup ever
  // touches, which Node turns into a crash. The `.catch` exists only to give
  // that derived promise a handler; the real error still reaches the caller
  // through `running`.
  void running
    .finally(() => {
      const slot = inFlightBuilds.get(location.sourceDir)
      // Only clear if nothing queued a follow-up while this build ran. If one
      // was queued, its own `.then` (above) is about to call startBuild and
      // overwrite this slot with the follow-up's own — clearing here first
      // would open a gap where a caller arriving in between finds no slot at
      // all and starts a redundant third build instead of joining the one
      // already coalesced for it.
      if (slot?.running === running && !slot.next) {
        inFlightBuilds.delete(location.sourceDir)
      }
    })
    .catch(() => {})
  return running
}

// A build finishes in seconds, so a staging directory this old belongs to an
// attempt whose process died before its rename or cleanup could run. Swept at
// the start of the next build so crashed attempts do not accumulate; anything
// younger is left alone, because it may be another in-flight attempt's live
// staging.
const STALE_STAGING_MS = 10 * 60 * 1000

async function sweepStaleStaging(distDir: string): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS
  let names: string[]
  try {
    names = await fs.readdir(distDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!isStagingName(name)) {
      continue
    }
    const full = path.join(distDir, name)
    try {
      if ((await fs.stat(full)).mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true })
      }
    } catch {
      // A racing rename or cleanup got to it first — fine either way.
    }
  }
}

async function buildExtensionNow(location: BuildLocation, manifest: ExtensionManifest): Promise<BuildResult> {
  await sweepStaleStaging(location.distDir)
  const installErrors = await ensureDependencies(location.sourceDir)
  if (installErrors.length > 0) {
    return {
      success: false,
      errors: installErrors,
      warnings: [],
      clientHash: String(Date.now()),
      serverHash: String(Date.now()),
    }
  }
  const [client, server] = await Promise.all([
    compileSide(location, manifest, 'client'),
    compileSide(location, manifest, 'server'),
  ])
  const errors = [...client.errors, ...server.errors]
  const deprecations = [
    ...(await scanDeprecatedManifestKeys(location.sourceDir, client.sources)),
    ...(await scanDeprecatedApiUses(location.sourceDir, [
      { side: 'client', files: client.sources },
      { side: 'server', files: server.sources },
    ])),
  ]
  logDeprecations(location.extensionId, deprecations)
  const warnings = [...client.warnings, ...server.warnings, ...deprecations.map(deprecationWarning)]
  if (errors.length === 0) {
    errors.push(...(await compileClientCss(location)))
  }
  if (errors.length === 0) {
    // Record what this bundle was built from, so a reader can tell what the
    // instance is RUNNING apart from what the checkout is now on. The commit
    // alone is not enough: a checkout is built as it stands, so a tree with
    // uncommitted work on top has a commit that is NOT what was built. The
    // dirty flag and paths are recorded beside it, or the bundle would claim
    // to be exactly a commit it is not. Read straight from the checkout at
    // build time; best-effort, and never a build failure, because a directory
    // that is not a git checkout still builds.
    const state = await readCheckoutState(location.sourceDir)
    await fs
      .writeFile(
        path.join(location.distDir, BUILD_PROVENANCE_FILE),
        JSON.stringify({
          commit: state.sourceCommit,
          dirty: state.sourceDirty,
          dirtyPaths: state.sourceDirtyPaths,
          builtAt: Date.now(),
        }),
      )
      .catch(() => {})
  }
  return {
    success: errors.length === 0,
    errors,
    warnings,
    clientHash: String(Date.now()),
    serverHash: String(Date.now()),
  }
}
