import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { extensionHostApi, extensionUiApi } from '@/app/_authed/(extension-runtime)/_client/host'
import { RETIRED_CLIENT_NAMES, SERVER_MODULES } from '@/app/_authed/(extension-runtime)/_server/extension-api-modules'
import { bindableNames, extensionScopedExports } from '@/app/_authed/(extension-runtime)/_server/host-shims'

/*
 * The deprecated extension API surface, written out as declarations: the
 * `legacy` namespaces of `@opencroft/client` and `@opencroft/server`, and the
 * `@ext/host` / `@ext/ui` modules an extension typecheck reads. Every name in
 * them is a re-export of the same name from the module that now owns it, with
 * a `@deprecated` tag naming that module, so an editor strikes the old
 * spelling through and says where to go. (The tag is on each export
 * specifier: TypeScript reads one on the statement for no name.)
 *
 * Generated rather than written because the source of truth is elsewhere: the
 * module files say which module owns a name, and the host's runtime objects
 * say which names `@ext/host` and `@ext/ui` really serve. A runtime name that
 * no module declares and nothing here retires stops the generation, so the
 * deprecated surface cannot quietly lose a name the host still serves.
 * host-api-declarations.test.ts fails while a checked-in file differs from what
 * this renders; `npm run generate:legacy-declarations -w apps/opencroft`
 * rewrites them.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
// _server -> (extension-runtime) -> _authed -> app -> apps/opencroft -> apps -> the repo root.
const REPO_ROOT = path.resolve(here, '../../../../../..')

/**
 * Names on the runtime surface that no module declares on purpose: the raw
 * forms the shims bind to the extension being built. Declaring one would
 * advertise the unbound form beside the bound one.
 */
export const UNDECLARED_BY_DESIGN = new Map<string, string>([
  ['callAction', 'The raw form of `invoke`, taking the extension id as its first argument.'],
  ['callNodeAction', 'The raw form of `dispatch`.'],
  ['extensionUrl', 'The raw form of `assetUrl` and `routeUrl`, taking the extension id as its first argument.'],
])

/** Where each retired client name's declaration comes from: a specifier, and the export spelled there. */
const RETIRED_SOURCES: Record<string, { from: string; name: string }> = {
  React: { from: 'react', name: 'default' },
  createPortal: { from: 'react-dom', name: 'createPortal' },
  toast: { from: 'sonner', name: 'toast' },
  InspectorTerminalBody: { from: '@opencroft/client/terminal', name: 'Terminal' },
  // A namespace: re-exported through a namespace import, see retiredReexports.
  icons: { from: 'lucide-react', name: '*' },
}

const HEADER = `// GENERATED from the extension API modules and the host's runtime surface by
// apps/opencroft/app/_authed/(extension-runtime)/_server/legacy-declarations.ts.
// Do not edit: run \`npm run generate:legacy-declarations -w apps/opencroft\`.
`

interface ModuleExports {
  values: string[]
  types: string[]
}

type Package = 'client' | 'server'

interface Reexport {
  name: string
  isType: boolean
  message: string
}

export interface GeneratedFile {
  /** Relative to the repository root. */
  path: string
  content: string
}

export function repoPath(relative: string): string {
  return path.join(REPO_ROOT, relative)
}

function packageDir(pkg: Package): string {
  return path.join(REPO_ROOT, 'packages', pkg)
}

/** The modules a package's `exports` map names, except its root. */
export function packageModules(pkg: Package): string[] {
  const manifest = ts.sys.readFile(path.join(packageDir(pkg), 'package.json'))
  if (!manifest) {
    throw new Error(`packages/${pkg}/package.json is missing`)
  }
  const exports = (JSON.parse(manifest) as { exports: Record<string, string> }).exports
  return Object.keys(exports)
    .filter((key) => key !== '.')
    .map((key) => key.replace(/^\.\//, ''))
    .sort()
}

/** What each module of a package declares, as the type checker resolves it (so `export *` is followed). */
export function readModuleExports(pkg: Package): Record<string, ModuleExports> {
  const dir = packageDir(pkg)
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile)
  if (config.error) {
    throw new Error(`packages/${pkg}/tsconfig.json does not parse`)
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir)
  const modules = packageModules(pkg)
  const files = modules.map((module) => path.join(dir, 'src', `${module}.ts`))
  const program = ts.createProgram(files, parsed.options)
  const checker = program.getTypeChecker()
  const result: Record<string, ModuleExports> = {}
  for (const [index, module] of modules.entries()) {
    const source = program.getSourceFile(files[index])
    const symbol = source && checker.getSymbolAtLocation(source)
    if (!symbol) {
      throw new Error(`packages/${pkg}/src/${module}.ts did not load as a module`)
    }
    const values: string[] = []
    const types: string[] = []
    for (const exported of checker.getExportsOfModule(symbol)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      ;(target.flags & ts.SymbolFlags.Value ? values : types).push(exported.getName())
    }
    result[module] = { values: values.sort(), types: types.sort() }
  }
  return result
}

/** Which module declares each name. A name declared by two modules is an error: the root re-exports both. */
export function moduleOwners(exports: Record<string, ModuleExports>): Map<string, string> {
  const owner = new Map<string, string>()
  for (const [module, { values, types }] of Object.entries(exports)) {
    for (const name of [...values, ...types]) {
      const other = owner.get(name)
      if (other) {
        throw new Error(`\`${name}\` is declared by both ${other} and ${module}; a name has one module`)
      }
      owner.set(name, module)
    }
  }
  return owner
}

const moved = (pkg: Package, name: string, module: string): Reexport => ({
  name,
  isType: false,
  message: `Import \`${name}\` from \`@opencroft/${pkg}/${module}\`.`,
})

function reexportBlock(specifier: string, entries: Reexport[]): string {
  if (entries.length === 0) {
    return ''
  }
  const onlyTypes = entries.every((entry) => entry.isType)
  const lines = entries.map(
    ({ name, isType, message }) => `  /** @deprecated ${message} */\n  ${isType && !onlyTypes ? 'type ' : ''}${name},`,
  )
  return `export ${onlyTypes ? 'type ' : ''}{\n${lines.join('\n')}\n} from '${specifier}'\n`
}

// The files are written as the repository's formatter and import sorter
// would leave them, by running them through it: they are checked by the same
// lint as everything else, and `npm run fix` must find nothing to change.
const BIOME = path.join(REPO_ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome')

function formatted(file: GeneratedFile): GeneratedFile {
  const run = spawnSync(process.execPath, [BIOME, 'check', '--write', `--stdin-file-path=${file.path}`], {
    cwd: REPO_ROOT,
    input: file.content,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.status !== 0 || !run.stdout) {
    throw new Error(`biome could not format ${file.path}: ${run.stderr || `exit ${run.status}`}`)
  }
  return { ...file, content: run.stdout }
}

/** Every export of every module, re-exported under its own name with the module it moved to. */
function moduleReexports(
  pkg: Package,
  exports: Record<string, ModuleExports>,
  specifierOf: (module: string) => string,
) {
  return Object.entries(exports)
    .map(([module, { values, types }]) =>
      reexportBlock(specifierOf(module), [
        ...values.map((name) => moved(pkg, name, module)),
        ...types.map((name) => ({ ...moved(pkg, name, module), isType: true })),
      ]),
    )
    .join('')
}

/**
 * The retired names among `names`, each re-exported from where its replacement
 * lives. `local` rewrites a specifier for a file inside the client package.
 */
function retiredReexports(names: string[], local: (specifier: string) => string = (specifier) => specifier): string {
  return names
    .filter((name) => Object.hasOwn(RETIRED_SOURCES, name))
    .sort()
    .map((name) => {
      const { name: source } = RETIRED_SOURCES[name]
      const from = local(RETIRED_SOURCES[name].from)
      const message = `Use ${RETIRED_CLIENT_NAMES[name]}.`
      if (source === '*') {
        const local = `${name}Namespace`
        return `import * as ${local} from '${from}'\nexport {\n  /** @deprecated ${message} */\n  ${local} as ${name},\n}\n`
      }
      const spec = source === name ? name : `${source} as ${name}`
      return `export {\n  /** @deprecated ${message} */\n  ${spec},\n} from '${from}'\n`
    })
    .join('')
}

/** The module of a runtime client name; null for a retired one. Throws for a name nothing accounts for. */
function clientHome(name: string, owner: Map<string, string>): string | null {
  const module = owner.get(name)
  if (module) {
    return module
  }
  if (Object.hasOwn(RETIRED_SOURCES, name)) {
    return null
  }
  throw new Error(
    `\`${name}\` is on the host's runtime extension surface, but no @opencroft/client module declares it and it is not retired`,
  )
}

/** Runtime value names re-exported from their modules, grouped by module. */
function clientValueReexports(names: string[], owner: Map<string, string>): string {
  const byModule = new Map<string, Reexport[]>()
  for (const name of names.sort()) {
    const module = clientHome(name, owner)
    if (module) {
      byModule.set(module, [...(byModule.get(module) ?? []), moved('client', name, module)])
    }
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, entries]) => reexportBlock(`@opencroft/client/${module}`, entries))
    .join('')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n')
}

function renderClientLegacy(client: Record<string, ModuleExports>): string {
  return `${HEADER}/**
 * \`legacy\` — the deprecated \`@ext/host\` + \`@ext/ui\` client surface under one
 * namespace. Every name here is its module's own, re-exported; import it from
 * that module instead.
 */
${moduleReexports('client', client, (module) => `./${module}`)}${retiredReexports(Object.keys(RETIRED_SOURCES), (specifier) => specifier.replace('@opencroft/client/', './'))}`
}

function renderServerLegacy(server: Record<string, ModuleExports>): string {
  return `${HEADER}/**
 * \`legacy\` — the server host's whole surface under one namespace,
 * deprecated. Every name here is its module's own, re-exported; import it from
 * that module instead.
 */
${moduleReexports('server', server, (module) => `./${module}`)}`
}

/**
 * `@ext/host` and `@ext/ui` as an extension typecheck reads them. `@ext/host`
 * serves the client host in a client build and the server host in a server
 * build, so it declares both: the client's names and the server's, and a
 * default export that is either host. The names both hosts have (the
 * extension's id and URLs) are declared as the two at once.
 */
function renderExtModules(client: Record<string, ModuleExports>): string {
  const owner = moduleOwners(client)
  const visible = (names: string[]) => names.filter((name) => !UNDECLARED_BY_DESIGN.has(name))
  const scoped = extensionScopedExports('acme.probe').map((entry) => entry.name)
  const hostNames = visible([...new Set([...bindableNames(extensionHostApi), ...scoped])])
  const uiNames = visible(bindableNames(extensionUiApi))

  const serverModuleOf = new Map<string, string>(
    Object.entries(SERVER_MODULES).flatMap(([module, names]) => names.map((name) => [name, module] as const)),
  )
  const shared = hostNames.filter((name) => serverModuleOf.has(name))
  const clientOnly = hostNames.filter((name) => !serverModuleOf.has(name))

  const serverReexports = Object.entries(SERVER_MODULES)
    .map(([module, names]: [string, readonly string[]]) =>
      reexportBlock(
        `@opencroft/server/${module}`,
        names.filter((name) => !shared.includes(name)).map((name) => moved('server', name, module)),
      ),
    )
    .join('')
  const sharedDeclarations = shared
    .sort()
    .map((name) => {
      const clientModule = clientHome(name, owner)
      const serverModule = serverModuleOf.get(name)
      return `/** @deprecated Import \`${name}\` from \`@opencroft/client/${clientModule}\` in client code, or \`@opencroft/server/${serverModule}\` in server code. */
export const ${name}: typeof import('@opencroft/client/${clientModule}').${name} &
  typeof import('@opencroft/server/${serverModule}').${name}
`
    })
    .join('')
  const types = Object.entries(client)
    .map(([module, exports]) =>
      reexportBlock(
        `@opencroft/client/${module}`,
        exports.types.map((name) => ({ ...moved('client', name, module), isType: true })),
      ),
    )
    .join('')
  const retired = (names: string[]) => retiredReexports(names.filter((name) => owner.get(name) === undefined))

  const host = `${clientValueReexports(clientOnly, owner)}${retired(clientOnly)}${serverReexports}${sharedDeclarations}${types}
/**
 * @deprecated The whole host: the server host in server code, the client host
 * in client code. Import each capability from its module of
 * \`@opencroft/server\` or \`@opencroft/client\` instead.
 */
const host: import('@opencroft/server').ExtensionServerHost & typeof import('@opencroft/client').legacy
export default host
`
  const ui = `${clientValueReexports(uiNames, owner)}${retired(uiNames)}${types}`

  return `${HEADER}// The deprecated \`@ext/host\` and \`@ext/ui\` modules, for an extension typecheck.

declare module '@ext/host' {
${indent(host)}}

declare module '@ext/ui' {
${indent(ui)}}
`
}

/** The generated files, with what each should contain now. */
export function renderLegacyDeclarations(): GeneratedFile[] {
  const client = readModuleExports('client')
  const server = readModuleExports('server')
  moduleOwners(server)
  return [
    { path: 'packages/client/src/legacy.ts', content: renderClientLegacy(client) },
    { path: 'packages/server/src/legacy.ts', content: renderServerLegacy(server) },
    { path: 'packages/client/ext-modules.d.ts', content: renderExtModules(client) },
  ].map(formatted)
}
