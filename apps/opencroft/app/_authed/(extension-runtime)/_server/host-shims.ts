import type * as esbuild from 'esbuild'

import { type ExtensionUrlKind, extensionUrlBase } from '@/app/_authed/(extension-runtime)/_extension-id'
import { loadClientHostApi } from '@/app/_authed/(extension-runtime)/_server/client-host-api'
import {
  type ClientModule,
  isServerModule,
  SERVER_MODULES,
  serverModuleNames,
} from '@/app/_authed/(extension-runtime)/_server/extension-api-modules'

// The modules an extension imports the host through -- `@opencroft/client`,
// `@opencroft/server` and each of their modules, and the deprecated `@ext/host`
// and `@ext/ui` -- resolve to generated shims over the API objects the host
// injects at run time (`__extHost` in the browser, `__extensionServerApi` on
// the server). The packages only declare that API; nothing of theirs is
// bundled.

const HOST_SPECIFIER = /^(?:@ext\/(?:host|ui)|@opencroft\/(?:client|server)(?:\/[^/]+)?)$/
const PACKAGE_MODULE = /^@opencroft\/(client|server)\/(.+)$/

/** A client export the shim declares itself, bound to the extension being built, and the module it belongs to. */
export interface ScopedExport {
  name: string
  code: string
  module: ClientModule
}

// What the client shims declare themselves rather than forwarding off the host
// objects, because each is bound to the extension being built: `createStorage`
// namespaces by extension id, `invoke` targets this extension's own actions.
//
// The declarations and the names excluded from the forwarded set are one list,
// not two beside each other. A ninth name added here is excluded by
// construction; kept as a separate set it would be forwarded as well, and a
// duplicate binding is a syntax error that fails every extension build rather
// than one name.
export function extensionScopedExports(extensionId: string): ScopedExport[] {
  const quoted = JSON.stringify(extensionId)
  const quotedBase = JSON.stringify(extensionUrlBase(extensionId))
  // The URL shape is defined once, in _extension-id.ts; the host's `extensionUrl`
  // applies it, so no path is spelled out in generated code.
  const under = (kind: ExtensionUrlKind) => `(p) => __host.extensionUrl(${quoted}, '${kind}', p)`
  return [
    { name: 'extensionId', module: 'extension', code: quoted },
    { name: 'urlBase', module: 'extension', code: quotedBase },
    { name: 'assetUrl', module: 'extension', code: under('assets') },
    { name: 'routeUrl', module: 'extension', code: under('http') },
    // For a URL handed outside the instance. There is no instance-origin
    // setting, so the origin is the page's own.
    {
      name: 'absoluteUrl',
      module: 'extension',
      code: `(url = ${quotedBase}) => new URL(url, location.origin).href`,
    },
    { name: 'invoke', module: 'actions', code: `(name, ...args) => __host.callAction(${quoted}, name, args)` },
    {
      name: 'dispatch',
      module: 'actions',
      code: '(nodeId, actionId, params) => __host.callNodeAction(nodeId, actionId, params)',
    },
    { name: 'createStorage', module: 'storage', code: `(key) => __host.createStorage(${quoted}, key)` },
  ]
}

// Names that are legal object keys and legal property accesses, but cannot be
// bound: `const { <word> } = host` is a syntax error, and the shim is a module,
// so it is always strict mode -- which is why the strict-mode-only reservations
// and `eval`/`arguments` belong here alongside the unconditional keywords.
// Listed rather than discovered by trying, so a key that cannot become a named
// export leaves extension builds working and the capability reachable through
// the default export, while the surface test -- which demands every key of the
// object back out of a real build -- fails and says which name has no
// idiomatic import.
const RESERVED_WORDS = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

export function bindableNames(api: object): string[] {
  return Object.keys(api).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_WORDS.has(name))
}

// `export const { a, b } = source` -- the same destructured re-export the react
// shim below uses, wrapped so a few hundred component names stay readable in a
// browser's view of the bundle.
//
// Every forwarded name lands in the shim's own top-level scope, so the shim's
// locals are `__`-prefixed: an API key called `host` or `ui` would otherwise
// redeclare one, and a duplicate binding is a syntax error that fails every
// extension build rather than one name.
function destructuredExports(names: string[], source: string): string {
  if (names.length === 0) {
    return ''
  }
  const lines: string[] = []
  let line = ' '
  for (const name of names) {
    if (line.length + name.length + 2 > 100) {
      lines.push(line)
      line = ' '
    }
    line += ` ${name},`
  }
  lines.push(line)
  return `export const {\n${lines.join('\n')}\n} = ${source};`
}

const CLIENT_PREAMBLE = `
const __api = globalThis.__extHost;
if (!__api) { throw new Error('Extension API not installed'); }
const __host = __api.host;
`

const SERVER_PREAMBLE = `
const __api = globalThis.__extensionServerApi;
if (!__api) { throw new Error('Extension server API not installed'); }
const __host = __api.host;
`

function onlyOn(side: 'client' | 'server', specifier: string): esbuild.OnLoadResult {
  return { contents: `throw new Error("${specifier} is only available on the ${side}");`, loader: 'js' }
}

function unknownModule(pkg: string, module: string, known: string[]): esbuild.OnLoadResult {
  return {
    errors: [
      {
        text: `@opencroft/${pkg}/${module} is not a module of @opencroft/${pkg}. Its modules are: ${known.sort().join(', ')}.`,
      },
    ],
  }
}

export function hostVirtualPlugin(side: 'client' | 'server', extensionId: string): esbuild.Plugin {
  return {
    name: 'ext-host-virtual',
    setup(build) {
      build.onResolve({ filter: HOST_SPECIFIER }, (args) => ({ path: args.path, namespace: 'ext-host' }))
      // Redirect react imports to host's React (prevents duplicate React copies)
      if (side === 'client') {
        build.onResolve({ filter: /^(?:react|react\/jsx-runtime|react-dom|sonner|lucide-react)$/ }, (args) => ({
          path: args.path,
          namespace: 'ext-host',
        }))
      }
      build.onLoad({ filter: /.*/, namespace: 'ext-host' }, async (args) => {
        if (side === 'client') {
          return await clientHostShim(args.path, extensionId)
        }
        return serverHostShim(args.path)
      })
    },
  }
}

async function clientHostShim(specifier: string, extensionId: string): Promise<esbuild.OnLoadResult> {
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
  if (specifier === 'react/jsx-runtime') {
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
    // host.React) -- not stubbed to a no-op. A bare react-dom stub would silently
    // break any extension-bundled library whose components portal internally
    // (radix-ui's Portal, used by ContextMenu/DropdownMenu/etc.): the trigger's own
    // state would flip, since that's plain React state, but nothing would mount,
    // with no error, because a no-op createPortal discards what it is given.
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
  if (specifier === 'sonner') {
    // The host's own `toast`. A bundled copy of sonner keeps its toasts in a
    // store of its own, which no Toaster on the page reads, so every toast a
    // kit component raises would vanish without an error. Only `toast` is
    // forwarded: the host mounts the one Toaster, and an extension importing
    // another name fails its build rather than rendering a second one.
    return {
      contents: `
const toast = globalThis.__extHost.host.toast;
export { toast };
export default toast;
`,
      loader: 'js',
    }
  }
  if (specifier === 'lucide-react') {
    // The host's icon set (see safe-icons.ts on the app side), so an extension
    // carries no copy of its own and loads each icon the way the host does.
    // CommonJS on purpose: esbuild reads a named import from a CommonJS module
    // as a property access at runtime, so every icon is importable without
    // this module listing the whole set by name.
    return {
      contents: 'module.exports = globalThis.__extHost.host.icons;\n',
      loader: 'js',
    }
  }

  // The names each shim exports are read off the API objects the browser is
  // actually handed, not restated here. A hand-kept export list beside the
  // object it mirrors is two enumerations with nothing holding them together,
  // so a capability added to the object and missed in the list is unreachable
  // through the named import every other capability uses -- and the extension
  // that tries it fails to build on a name the host really does provide.
  const api = await loadClientHostApi()
  const scoped = extensionScopedExports(extensionId)
  const declareScoped = (entries: ScopedExport[]) =>
    entries.map((entry) => `export const ${entry.name} = ${entry.code};`).join('\n')
  const forwardModule = (module: ClientModule) =>
    destructuredExports(bindableNames(api.modules[module]), `__api.modules[${JSON.stringify(module)}]`)

  const packageModule = specifier.match(PACKAGE_MODULE)
  if (packageModule?.[1] === 'server') {
    return onlyOn('server', specifier)
  }
  if (packageModule) {
    const module = packageModule[2]
    if (!Object.hasOwn(api.modules, module)) {
      return unknownModule('client', module, Object.keys(api.modules))
    }
    const own = module as ClientModule
    return {
      contents: `${CLIENT_PREAMBLE}
${declareScoped(scoped.filter((entry) => entry.module === own))}
${forwardModule(own)}
`,
      loader: 'js',
    }
  }
  if (specifier === '@opencroft/client') {
    // Every module, plus `legacy`: the flat `@ext/host` + `@ext/ui` surface as
    // one object, carrying the bound names from the one list above, so the
    // two surfaces cannot come to disagree about what `createStorage` takes.
    const modules = Object.keys(api.modules) as ClientModule[]
    return {
      contents: `${CLIENT_PREAMBLE}
const __ui = __api.ui;
${declareScoped(scoped)}
${modules.map(forwardModule).join('\n')}
export const legacy = {
  ...__host,
  ...__ui,
${scoped.map((entry) => `  ${entry.name}: ${entry.code},`).join('\n')}
};
`,
      loader: 'js',
    }
  }
  if (specifier === '@ext/ui') {
    return {
      contents: `${CLIENT_PREAMBLE}
const __ui = __api.ui;
${destructuredExports(bindableNames(api.ui), '__ui')}
export default __ui;
`,
      loader: 'js',
    }
  }
  // `@ext/host`, and `@opencroft/server` imported into a client build, which
  // is given the client host.
  const scopedNames = new Set(scoped.map((entry) => entry.name))
  return {
    contents: `${CLIENT_PREAMBLE}
${declareScoped(scoped)}
${destructuredExports(
  bindableNames(api.host).filter((name) => !scopedNames.has(name)),
  '__host',
)}
export default __host;
`,
    loader: 'js',
  }
}

function serverHostShim(specifier: string): esbuild.OnLoadResult {
  if (specifier === '@ext/ui' || specifier.startsWith('@opencroft/client')) {
    return onlyOn('client', specifier)
  }
  const packageModule = specifier.match(PACKAGE_MODULE)
  if (packageModule) {
    const module = packageModule[2]
    if (!isServerModule(module)) {
      return unknownModule('server', module, Object.keys(SERVER_MODULES))
    }
    return {
      contents: `${SERVER_PREAMBLE}\n${destructuredExports([...SERVER_MODULES[module]], '__host')}\n`,
      loader: 'js',
    }
  }
  // The package root and the deprecated `@ext/host`: every module's names and
  // the whole host as the default export. `legacy` is the root's deprecated
  // namespace, which is the host itself.
  return {
    contents: `${SERVER_PREAMBLE}
${destructuredExports(serverModuleNames(), '__host')}
export default __host;
${specifier === '@opencroft/server' ? 'export const legacy = __host;' : ''}
`,
    loader: 'js',
  }
}
