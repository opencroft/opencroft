import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { compile as compileTailwind } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import * as esbuild from 'esbuild'
import * as lucideIcons from 'lucide-react'

import { extDir, extDistDir, projectRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
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

interface IconNameViolation {
  file: string
  name: string
}

// Flags `icons.<Name>` member access and names destructured out of `icons`
// where <Name> isn't a real export of the bundled icon package -- an icon
// name that only ever arrives as data, rather than being written into
// source, can't be seen here (see safe-icons.ts on the app side for that
// half). A regex scan over source text, not an AST walk: the same
// mechanical, good-enough approach the workspace-dependency check already
// uses elsewhere in this codebase, chosen for the same reason -- it is
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
async function findIconViolations(src: string, metafile: esbuild.Metafile): Promise<IconNameViolation[]> {
  const MEMBER_RE = /\bicons\.([A-Za-z_$][\w$]*)/g
  const DESTRUCTURE_RE = /\{([^{}]*)\}\s*=\s*icons\b/g
  const violations: IconNameViolation[] = []
  for (const relPath of Object.keys(metafile.inputs)) {
    if (!/\.[jt]sx?$/.test(relPath) || relPath.includes('node_modules')) {
      continue
    }
    const source = await fs.readFile(path.resolve(src, relPath), 'utf-8').catch(() => null)
    if (source === null) {
      continue
    }
    for (const match of source.matchAll(MEMBER_RE)) {
      const name = match[1]
      if (!ICON_NAMES.has(name) && !ICON_NAMESPACE_TYPE_EXPORTS.has(name)) {
        violations.push({ file: relPath, name })
      }
    }
    for (const match of source.matchAll(DESTRUCTURE_RE)) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(':')[0].trim()
        if (!name || name.startsWith('...')) {
          continue
        }
        if (!ICON_NAMES.has(name) && !ICON_NAMESPACE_TYPE_EXPORTS.has(name)) {
          violations.push({ file: relPath, name })
        }
      }
    }
  }
  return violations
}

function hostVirtualPlugin(side: 'client' | 'server', extensionId: string): esbuild.Plugin {
  return {
    name: 'ext-host-virtual',
    setup(build) {
      build.onResolve({ filter: /^@ext\/host$/ }, () => ({
        path: '@ext/host',
        namespace: 'ext-host',
      }))
      build.onResolve({ filter: /^@opencroft\/server$/ }, () => ({
        path: '@ext/host',
        namespace: 'ext-host',
      }))
      build.onResolve({ filter: /^@ext\/ui$/ }, () => ({
        path: '@ext/ui',
        namespace: 'ext-host',
      }))
      build.onResolve({ filter: /^@opencroft\/client$/ }, () => ({
        path: '@opencroft/client',
        namespace: 'ext-host',
      }))
      // Redirect react imports to host's React (prevents duplicate React copies)
      if (side === 'client') {
        build.onResolve({ filter: /^react$/ }, () => ({
          path: 'react',
          namespace: 'ext-host',
        }))
        build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
          path: 'react/jsx-runtime',
          namespace: 'ext-host',
        }))
        build.onResolve({ filter: /^react-dom$/ }, () => ({
          path: 'react-dom',
          namespace: 'ext-host',
        }))
      }
      build.onLoad({ filter: /.*/, namespace: 'ext-host' }, (args) => {
        if (side === 'client') {
          return clientHostShim(args.path, extensionId)
        }
        return serverHostShim(args.path)
      })
    },
  }
}

function clientHostShim(specifier: string, extensionId: string): esbuild.OnLoadResult {
  const quoted = JSON.stringify(extensionId)
  if (specifier === 'react') {
    return {
      contents: `
const api = globalThis.__extHost;
const React = api.host.React;
export default React;
export const {
  useState, useEffect, useCallback, useMemo, useRef, useContext,
  useReducer, useId, useLayoutEffect, useSyncExternalStore,
  useTransition, useDeferredValue, useImperativeHandle, useDebugValue,
  useInsertionEffect, startTransition,
  createElement, createContext, createRef, forwardRef, memo, lazy,
  Component, PureComponent, version,
  Fragment, Suspense, StrictMode, Children, cloneElement, isValidElement,
} = React;
`,
      loader: 'js',
    }
  }
  if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
    return {
      contents: `
const React = globalThis.__extHost.host.React;
export function jsx(type, props, key) {
  const { children, ...rest } = props || {};
  if (key !== undefined) { rest.key = key; }
  return Array.isArray(children)
    ? React.createElement(type, rest, ...children)
    : children !== undefined
      ? React.createElement(type, rest, children)
      : React.createElement(type, rest);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = React.Fragment;
`,
      loader: 'js',
    }
  }
  if (specifier === 'react-dom') {
    // createPortal is real (globalThis.__extHost.host.createPortal, wired to the
    // host app's own react-dom the same way the 'react' shim above wires up
    // host.React) -- not stubbed to a no-op. A bare react-dom stub silently broke
    // any extension-bundled library whose components portal internally (radix-ui's
    // Portal, used by ContextMenu/DropdownMenu/etc.): the trigger's own state still
    // flipped, since that's plain React state, but nothing ever mounted, with no
    // error, because createPortal's return value was thrown away by design.
    // flushSync stays a synchronous call-through -- forwarding it would need
    // exposing react-dom's real flushSync too, and unlike createPortal a fallback
    // that just runs the callback immediately is a reasonable degradation, not a
    // silent no-op.
    return {
      contents: `
const createPortal = globalThis.__extHost.host.createPortal;
export default { createPortal };
export { createPortal };
export const flushSync = (fn) => fn();
`,
      loader: 'js',
    }
  }
  if (specifier === '@ext/ui') {
    return {
      contents: `
const api = globalThis.__extHost;
if (!api) { throw new Error('Extension API not installed'); }
const ui = api.ui;
export const AgentAvatar = ui.AgentAvatar;
export const Badge = ui.Badge;
export const Button = ui.Button;
export const Input = ui.Input;
export const ControlledInput = ui.ControlledInput;
export const Label = ui.Label;
export const Flex = ui.Flex;
export const ScrollArea = ui.ScrollArea;
export const Select = ui.Select;
export const SelectTrigger = ui.SelectTrigger;
export const SelectContent = ui.SelectContent;
export const SelectItem = ui.SelectItem;
export const SelectValue = ui.SelectValue;
export const Separator = ui.Separator;
export const Textarea = ui.Textarea;
export const ChatMessage = ui.ChatMessage;
export const ChatInput = ui.ChatInput;
export const Slider = ui.Slider;
export const StatusIndicator = ui.StatusIndicator;
export const Tooltip = ui.Tooltip;
export const TooltipContent = ui.TooltipContent;
export const TooltipProvider = ui.TooltipProvider;
export const TooltipTrigger = ui.TooltipTrigger;
export const Dialog = ui.Dialog;
export const DialogClose = ui.DialogClose;
export const DialogContent = ui.DialogContent;
export const DialogDescription = ui.DialogDescription;
export const DialogFooter = ui.DialogFooter;
export const DialogHeader = ui.DialogHeader;
export const DialogTitle = ui.DialogTitle;
export const DialogTrigger = ui.DialogTrigger;
export const CodeEditor = ui.CodeEditor;
export const FileBrowser = ui.FileBrowser;
export const FileManagerProvider = ui.FileManagerProvider;
export const Terminal = ui.Terminal;
export const InspectorTerminalBody = ui.InspectorTerminalBody;
export const CommandBar = ui.CommandBar;
export const CommandBarMenu = ui.CommandBarMenu;
export const CommandBarMenuItem = ui.CommandBarMenuItem;
export const Collapsible = ui.Collapsible;
export const CollapsibleTrigger = ui.CollapsibleTrigger;
export const CollapsibleContent = ui.CollapsibleContent;
export const Switch = ui.Switch;
export const Tabs = ui.Tabs;
export const TabsList = ui.TabsList;
export const TabsTrigger = ui.TabsTrigger;
export const TabsContent = ui.TabsContent;
export const Schedules = ui.Schedules;
export default ui;
`,
      loader: 'js',
    }
  }
  if (specifier === '@opencroft/client') {
    return {
      contents: `
const api = globalThis.__extHost;
if (!api) { throw new Error('Extension API not installed'); }
const host = api.host;
const ui = api.ui;
const assetUrl = (p) => {
  const [scope, slug] = ${quoted}.split('/');
  return '/api/ext/' + scope + '/' + slug + '/assets/' + String(p).replace(/^\\/+/, '');
};
const routeUrl = (p) => {
  const [scope, slug] = ${quoted}.split('/');
  return '/api/ext/' + scope + '/' + slug + '/http/' + String(p).replace(/^\\/+/, '');
};
export const Terminal = ui.Terminal;
export const legacy = {
  ...host,
  ...ui,
  extensionId: ${quoted},
  assetUrl,
  routeUrl,
  invoke: (name, ...args) => host.callAction(${quoted}, name, args),
  dispatch: (nodeId, actionId, params) => host.callNodeAction(nodeId, actionId, params),
  createStorage: (key) => host.createStorage(${quoted}, key),
};
`,
      loader: 'js',
    }
  }
  return {
    contents: `
const api = globalThis.__extHost;
if (!api) { throw new Error('Extension API not installed'); }
const host = api.host;
export const React = host.React;
export const defineExtension = host.defineExtension;
export const NodeFrame = host.NodeFrame;
export const useNodeAccent = host.useNodeAccent;
export const NodeCard = host.NodeCard;
export const NodeCardHeader = host.NodeCardHeader;
export const NodeCardContent = host.NodeCardContent;
export const NodeResizer = host.NodeResizer;
export const InputHandle = host.InputHandle;
export const OutputHandle = host.OutputHandle;
export const useNodeContext = host.useNodeContext;
export const inspectorIntent = host.inspectorIntent;
export const useInspectorIntent = host.useInspectorIntent;
export const useOverlay = host.useOverlay;
export const useUrlParam = host.useUrlParam;
export const useGraphNodes = host.useGraphNodes;
export const useGraphEdges = host.useGraphEdges;
export const useReactFlow = host.useReactFlow;
export const useUpdateNodeInternals = host.useUpdateNodeInternals;
export const Handle = host.Handle;
export const Position = host.Position;
export const createStorage = (key) => host.createStorage(${quoted}, key);
export const extensionId = ${quoted};
export const assetUrl = (p) => {
  const [scope, slug] = ${quoted}.split('/');
  return '/api/ext/' + scope + '/' + slug + '/assets/' + String(p).replace(/^\\/+/, '');
};
export const routeUrl = (p) => {
  const [scope, slug] = ${quoted}.split('/');
  return '/api/ext/' + scope + '/' + slug + '/http/' + String(p).replace(/^\\/+/, '');
};
export const icons = host.icons;
export const toast = host.toast;
export const invoke = (name, ...args) => host.callAction(${quoted}, name, args);
export const dispatch = (nodeId, actionId, params) => host.callNodeAction(nodeId, actionId, params);
export const createPortal = host.createPortal;
export const getStream = host.getStream;
export const subscribe = host.subscribe;
export const broadcast = host.broadcast;
export const useDockerContainers = host.useDockerContainers;
export const useDockerSnapshotReceived = host.useDockerSnapshotReceived;
export const useSeedDockerContainers = host.useSeedDockerContainers;
export default host;
`,
    loader: 'js',
  }
}

function serverHostShim(specifier: string): esbuild.OnLoadResult {
  if (specifier === '@ext/ui' || specifier === '@opencroft/client') {
    return { contents: `throw new Error("${specifier} is only available on the client");`, loader: 'js' }
  }
  return {
    contents: `
const api = globalThis.__extensionServerApi;
if (!api) { throw new Error('Extension server API not installed'); }
const host = api.host;
export default host;
export const fs = host.fs;
export const os = host.os;
export const path = host.path;
export const exec = host.exec;
export const execFile = host.execFile;
export const cacheDir = host.cacheDir;
export const dataDir = host.dataDir;
export const crypto = host.crypto;
export const secrets = host.secrets;
export const settings = host.settings;
export const graph = host.graph;
export const storage = host.storage;
export const keyStore = host.keyStore;
export const secretsStore = host.secretsStore;
export const localhost = host.localhost;
export const wsl = host.wsl;
export const terminal = host.terminal;
export const ssh = host.ssh;
export const execContext = host.execContext;
export const events = host.events;
export const extensionId = host.extensionId;
`,
    loader: 'js',
  }
}

async function readDependencyNames(extensionId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(extDir(extensionId), 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    return Object.keys(pkg.dependencies ?? {})
  } catch {
    return []
  }
}

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

async function compileServerSide(
  extensionId: string,
  manifest: ExtensionManifest,
): Promise<{ errors: CompileError[]; warnings: CompileError[] }> {
  const src = extDir(extensionId)
  const outDir = extDistDir(extensionId)
  await fs.mkdir(outDir, { recursive: true })

  const entries = ['server/index.ts', 'server/index.tsx', 'extension.ts', 'extension.tsx']
  const entry = manifest.main ? path.join(src, manifest.main) : await pickEntry(src, entries)
  if (!entry) {
    return { errors: [], warnings: [] }
  }

  const finalOutfile = path.join(outDir, 'server.js')
  // buildExtension's in-flight guard stops two builds of the same extension
  // from running at once, but a route serving the finished bundle reads
  // straight off disk with no idea a build is running at all — and esbuild's
  // own write to `outfile` is not atomic. Build under a name nothing serves,
  // then publish with a rename once the whole side is ready; rename is
  // atomic within a filesystem, so a concurrent reader always sees either the
  // old bundle or the new one, never a partial one. The temp file sits beside
  // the target to keep it on the same device. Unique per attempt so a
  // leftover from a previous crashed build can never collide with this one.
  buildAttemptCounter += 1
  const outfile = `${finalOutfile}.building-${process.pid}-${buildAttemptCounter}`

  // Server bundles must not inline the extension's own dependencies: native
  // modules (sharp, ffmpeg-static) break when bundled, and bundling JS that is
  // then run against a different copy of the same package in the app's
  // node_modules causes version/ABI clashes. Keep them as runtime requires,
  // resolved from the extension's node_modules by the loader.
  const serverExternals = [
    ...SERVER_EXTERNAL_PACKAGES,
    ...(await readDependencyNames(extensionId)).filter((name) => !ALWAYS_BUNDLED_PACKAGES.includes(name)),
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
      plugins: [hostVirtualPlugin('server', extensionId)],
      external: serverExternals,
      logLevel: 'silent',
      write: true,
      absWorkingDir: src,
      nodePaths: [path.join(src, 'node_modules'), ...PROJECT_NODE_MODULES],
    })
    await fs.rename(outfile, finalOutfile).catch(() => {})
    return {
      errors: toCompileErrors(result.errors),
      warnings: toCompileErrors(result.warnings),
    }
  } catch (err) {
    await fs.rm(outfile, { force: true }).catch(() => {})
    const buildErr = err as esbuild.BuildFailure
    return {
      errors: buildErr.errors ? toCompileErrors(buildErr.errors) : [{ file: entry, message: String(err) }],
      warnings: buildErr.warnings ? toCompileErrors(buildErr.warnings) : [],
    }
  }
}

async function compileClientSide(
  extensionId: string,
  manifest: ExtensionManifest,
): Promise<{ errors: CompileError[]; warnings: CompileError[] }> {
  const src = extDir(extensionId)
  const outDir = extDistDir(extensionId)
  await fs.mkdir(outDir, { recursive: true })

  const entries = ['src/client.tsx', 'src/client.ts', 'src/index.tsx', 'src/index.ts']
  const entry = await pickEntry(src, entries)
  if (!entry) {
    return { errors: [], warnings: [] }
  }

  // A whole directory this time, not a single file — splitting can emit any
  // number of chunks alongside the entry, and none of them may become visible
  // under a served name before every file it (transitively) needs is already
  // there (see publishClientBuild). Staged as a sibling of `dist`, same
  // reasoning as the server side's temp file: same device, unique per attempt
  // so a leftover from a crashed build can never collide with this one.
  buildAttemptCounter += 1
  const stagingDir = `${outDir}.building-${process.pid}-${buildAttemptCounter}`

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
      plugins: [hostVirtualPlugin('client', extensionId), clientStubPlugin(stubSpecifiers, matchedStubs)],
      // Only for findIconViolations below, read after the build has settled
      // — see its own comment for why that must not happen during the build.
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
    // A declared stub that never matched an import is the same class of
    // mistake as a typo'd dependency name — reported as a build error rather
    // than silently doing nothing, so the extension author finds out from
    // the build instead of from a bundle that quietly stayed large.
    const unmatchedStubs = stubSpecifiers.filter((specifier) => !matchedStubs.has(specifier))
    const iconViolations = result.metafile ? await findIconViolations(src, result.metafile) : []
    return {
      errors: [
        ...toCompileErrors(result.errors),
        ...unmatchedStubs.map((specifier) => ({
          file: 'extension.json',
          message: `clientStubs entry "${specifier}" never matched an import in the client build — remove it or fix the specifier.`,
        })),
        ...iconViolations.map((v) => ({
          file: v.file,
          message: `icons.${v.name} is not an export of the bundled icon package — this renders as a blank element at runtime (React error #130), not a build failure the bundler can see on its own.`,
        })),
      ],
      warnings: toCompileErrors(result.warnings),
    }
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    const buildErr = err as esbuild.BuildFailure
    return {
      errors: buildErr.errors ? toCompileErrors(buildErr.errors) : [{ file: entry, message: String(err) }],
      warnings: buildErr.warnings ? toCompileErrors(buildErr.warnings) : [],
    }
  }
}

async function compileSide(
  extensionId: string,
  manifest: ExtensionManifest,
  side: 'client' | 'server',
): Promise<{ errors: CompileError[]; warnings: CompileError[] }> {
  return side === 'client' ? compileClientSide(extensionId, manifest) : compileServerSide(extensionId, manifest)
}

// Extensions compile at runtime, long after the host CSS was built — so each
// extension gets its own Tailwind pass over its client sources. The entry
// references the host theme without re-emitting tokens or preflight, and the
// utilities land in the host's `utilities` cascade layer so both sheets merge
// predictably (identical classes compile to identical rules).
//
// The explicit layer statement matters: extension sheets are injected BEFORE
// the host stylesheet (see _client/loader.ts), so the first sheet to load must
// establish the same layer order the host expects, and duplicated utilities
// resolve to the host's canonical ordering.
const EXT_CSS_ENTRY = `
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' theme(reference);
@import 'ui/theme.css' theme(reference);
@import 'tw-animate-css';
@import 'tailwindcss/utilities.css' layer(utilities);
`

async function compileClientCss(extensionId: string): Promise<CompileError[]> {
  const srcDir = path.join(extDir(extensionId), 'src')
  const finalOutfile = path.join(extDistDir(extensionId), 'client.css')
  // Same reasoning as compileSide's publish step: client.css is served by the
  // same route as client.js, and writing straight to the served path is not
  // atomic — a reader can catch it mid-write. Build to a temp name beside the
  // target and rename into place once ready.
  buildAttemptCounter += 1
  const outfile = `${finalOutfile}.building-${process.pid}-${buildAttemptCounter}`
  try {
    const compiler = await compileTailwind(EXT_CSS_ENTRY, { base: projectRoot(), onDependency: () => {} })
    const scanner = new Scanner({ sources: [{ base: srcDir, pattern: '**/*', negated: false }] })
    const css = compiler.build(scanner.scan())
    await fs.writeFile(outfile, css)
    await fs.rename(outfile, finalOutfile)
    return []
  } catch (err) {
    await fs.rm(outfile, { force: true }).catch(() => {})
    return [{ file: 'client.css', message: String(err) }]
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
async function ensureDependencies(extensionId: string): Promise<CompileError[]> {
  const dir = extDir(extensionId)
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

const inFlightBuilds = new Map<string, BuildSlot>()

export function buildExtension(extensionId: string, manifest: ExtensionManifest): Promise<BuildResult> {
  const slot = inFlightBuilds.get(extensionId)
  if (!slot) {
    return startBuild(extensionId, manifest)
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
      () => startBuild(extensionId, manifest),
      () => startBuild(extensionId, manifest),
    )
  }
  return slot.next
}

function startBuild(extensionId: string, manifest: ExtensionManifest): Promise<BuildResult> {
  const running = buildExtensionNow(extensionId, manifest)
  inFlightBuilds.set(extensionId, { running, next: null })
  // `running` itself is returned below and handled by the caller. `.finally`
  // derives a NEW promise that adopts running's rejection, and nothing here
  // awaits or handles that derived one — left alone, a rejected build would
  // be an unhandled rejection on a promise nobody but this cleanup ever
  // touches, which Node turns into a crash. The `.catch` exists only to give
  // that derived promise a handler; the real error still reaches the caller
  // through `running`.
  void running
    .finally(() => {
      const slot = inFlightBuilds.get(extensionId)
      // Only clear if nothing queued a follow-up while this build ran. If one
      // was queued, its own `.then` (above) is about to call startBuild and
      // overwrite this slot with the follow-up's own — clearing here first
      // would open a gap where a caller arriving in between finds no slot at
      // all and starts a redundant third build instead of joining the one
      // already coalesced for it.
      if (slot?.running === running && !slot.next) {
        inFlightBuilds.delete(extensionId)
      }
    })
    .catch(() => {})
  return running
}

async function buildExtensionNow(extensionId: string, manifest: ExtensionManifest): Promise<BuildResult> {
  const installErrors = await ensureDependencies(extensionId)
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
    compileSide(extensionId, manifest, 'client'),
    compileSide(extensionId, manifest, 'server'),
  ])
  const errors = [...client.errors, ...server.errors]
  const warnings = [...client.warnings, ...server.warnings]
  if (errors.length === 0) {
    errors.push(...(await compileClientCss(extensionId)))
  }
  return {
    success: errors.length === 0,
    errors,
    warnings,
    clientHash: String(Date.now()),
    serverHash: String(Date.now()),
  }
}
