import { promises as fs } from 'node:fs'
import path from 'node:path'

import { compile as compileTailwind } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import * as esbuild from 'esbuild'

import { extDir, extDistDir, projectRoot } from '@/app/(extension-runtime)/_server/paths'
import type { BuildResult, CompileError, ExtensionManifest } from '@/app/(extension-runtime)/_types'

const PROJECT_NODE_MODULES = path.join(projectRoot(), 'node_modules')

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
  createElement, createContext, forwardRef, memo, lazy,
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
    return {
      contents: `
export default {};
export const createPortal = () => null;
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
export const FileBrowser = ui.FileBrowser;
export const FileManagerProvider = ui.FileManagerProvider;
export const Terminal = ui.Terminal;
export const InspectorTerminalBody = ui.InspectorTerminalBody;
export const CommandBar = ui.CommandBar;
export const CommandBarMenu = ui.CommandBarMenu;
export const CommandBarMenuItem = ui.CommandBarMenuItem;
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
export const crypto = host.crypto;
export const secrets = host.secrets;
export const settings = host.settings;
export const graph = host.graph;
export const storage = host.storage;
export const keyStore = host.keyStore;
export const secretsStore = host.secretsStore;
export const localhost = host.localhost;
export const wsl = host.wsl;
export const openclaw = host.openclaw;
export const terminal = host.terminal;
export const ssh = host.ssh;
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

async function compileSide(
  extensionId: string,
  manifest: ExtensionManifest,
  side: 'client' | 'server',
): Promise<{ errors: CompileError[]; warnings: CompileError[] }> {
  const src = extDir(extensionId)
  const outDir = extDistDir(extensionId)
  await fs.mkdir(outDir, { recursive: true })

  const entries =
    side === 'client'
      ? ['src/client.tsx', 'src/client.ts', 'src/index.tsx', 'src/index.ts']
      : ['server/index.ts', 'server/index.tsx', 'extension.ts', 'extension.tsx']
  const entry = manifest.main && side === 'server' ? path.join(src, manifest.main) : await pickEntry(src, entries)
  if (!entry) {
    return { errors: [], warnings: [] }
  }

  const outfile = path.join(outDir, side === 'client' ? 'client.js' : 'server.js')
  const format = side === 'client' ? 'esm' : 'cjs'
  const platform = side === 'client' ? 'browser' : 'node'

  // Server bundles must not inline the extension's own dependencies: native
  // modules (sharp, ffmpeg-static) break when bundled, and bundling JS that is
  // then run against a different copy of the same package in the app's
  // node_modules causes version/ABI clashes. Keep them as runtime requires,
  // resolved from the extension's node_modules by the loader.
  const serverExternals =
    side === 'server'
      ? [
          ...SERVER_EXTERNAL_PACKAGES,
          ...(await readDependencyNames(extensionId)).filter((name) => !ALWAYS_BUNDLED_PACKAGES.includes(name)),
        ]
      : []

  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format,
      platform,
      target: 'es2022',
      outfile,
      sourcemap: 'inline',
      jsx: 'automatic',
      plugins: [hostVirtualPlugin(side, extensionId)],
      external: serverExternals,
      logLevel: 'silent',
      write: true,
      absWorkingDir: src,
      nodePaths: [path.join(src, 'node_modules'), PROJECT_NODE_MODULES],
    })
    return {
      errors: toCompileErrors(result.errors),
      warnings: toCompileErrors(result.warnings),
    }
  } catch (err) {
    const buildErr = err as esbuild.BuildFailure
    return {
      errors: buildErr.errors ? toCompileErrors(buildErr.errors) : [{ file: entry, message: String(err) }],
      warnings: buildErr.warnings ? toCompileErrors(buildErr.warnings) : [],
    }
  }
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
  try {
    const compiler = await compileTailwind(EXT_CSS_ENTRY, { base: projectRoot(), onDependency: () => {} })
    const scanner = new Scanner({ sources: [{ base: srcDir, pattern: '**/*', negated: false }] })
    const css = compiler.build(scanner.scan())
    await fs.writeFile(path.join(extDistDir(extensionId), 'client.css'), css)
    return []
  } catch (err) {
    return [{ file: 'client.css', message: String(err) }]
  }
}

export async function buildExtension(extensionId: string, manifest: ExtensionManifest): Promise<BuildResult> {
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
