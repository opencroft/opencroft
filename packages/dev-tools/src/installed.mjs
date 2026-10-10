// Which files a shadcn / design-kit install writes, so fix and check leave
// them alone.
//
// An installed file belongs to its registry: the next install overwrites it
// with the registry's bytes, so formatting or lint-fixing it here only produces
// a diff the next install reverts, and a finding in it is the registry's to fix.
//
// The installer keeps no record of what it wrote. What it does keep is the
// `components.json` it reads, whose aliases say where each kind of item lands.
// Two of them are destinations only an install writes to:
//
//   - `ui`    — registry:ui items, the primitives and every kit component
//   - `hooks` — registry:hook items
//
// and a third that the design kit adds by convention:
//
//   - `<components>/hooks` — the kit serves a hook with the target
//     `components/hooks/<name>`, which lands beneath the `components` alias's
//     directory rather than under `hooks`
//
// so every file under any of these counts as installed. `components` itself
// and `lib` are not used: they name directories the host's own code lives in
// too (`@/components`, `@/lib`). Reading the aliases rather than a list means a
// newly installed component is skipped with no edit anywhere, and a repository
// that installs nothing has no `components.json` and nothing skipped.
//
// Test files under those directories are the host's own — no registry ships a
// test — so they are kept in.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const INSTALL_ALIASES = ['ui', 'hooks']
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** JSON with comments and trailing commas, as tsconfig files are written. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const readJson = (file) => parseJsonc(readFileSync(file, 'utf8'))

/** `paths` of a tsconfig, following relative `extends`, each target made absolute. */
function tsconfigPaths(file, seen = new Set()) {
  if (!existsSync(file) || seen.has(file)) {
    return {}
  }
  seen.add(file)
  const config = readJson(file)
  const dir = path.dirname(file)
  const parents = [config.extends ?? []].flat().filter((entry) => entry.startsWith('.'))
  let paths = {}
  for (const parent of parents) {
    const target = path.resolve(dir, parent.endsWith('.json') ? parent : `${parent}.json`)
    paths = { ...paths, ...tsconfigPaths(target, seen) }
  }
  const own = config.compilerOptions?.paths
  if (own) {
    const base = path.resolve(dir, config.compilerOptions.baseUrl ?? '.')
    for (const [key, targets] of Object.entries(own)) {
      paths[key] = targets.map((target) => path.resolve(base, target))
    }
  }
  return paths
}

/** Workspace packages of the repository, by name. */
function workspacePackages(root) {
  const manifest = path.join(root, 'package.json')
  if (!existsSync(manifest)) {
    return new Map()
  }
  const patterns = [readJson(manifest).workspaces ?? []].flat()
  const found = new Map()
  for (const pattern of patterns) {
    // Only the `dir/*` shape npm workspaces here use; anything richer is
    // refused below by name rather than half-matched.
    const parent = pattern.endsWith('/*') ? path.join(root, pattern.slice(0, -2)) : null
    const dirs = parent
      ? existsSync(parent)
        ? readdirNames(parent).map((name) => path.join(parent, name))
        : []
      : [path.join(root, pattern)]
    for (const dir of dirs) {
      const pkg = path.join(dir, 'package.json')
      if (existsSync(pkg)) {
        found.set(readJson(pkg).name, dir)
      }
    }
  }
  return found
}

function readdirNames(dir) {
  return readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory())
}

/** Longest `prefix*` pattern of a map whose prefix `specifier` starts with. */
function matchWildcard(map, specifier) {
  let best = null
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*')
    if (star === -1) {
      if (key === specifier) {
        return { rest: '', target: value, exact: true }
      }
      continue
    }
    const prefix = key.slice(0, star)
    const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    const fits = specifier.startsWith(prefix) || specifier === bare
    if (fits && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, rest: specifier.slice(prefix.length), target: value }
    }
  }
  return best
}

/** The directory a target pattern (`./src/components/*.tsx`) names for `rest`. */
const directoryOf = (target, rest) => {
  const star = target.indexOf('*')
  return path.join(star === -1 ? target : target.slice(0, star), rest)
}

/**
 * The directory an alias names, resolved the two ways an import can resolve
 * here: the components.json directory's own tsconfig `paths` (`@/hooks`), or a
 * workspace package and its `exports` (`ui/components/ui`).
 *
 * An alias that resolves neither way is an error, not a skip: a silently
 * unresolved alias means installed files get formatted and linted again, which
 * is the defect this module exists to prevent.
 */
export function resolveAlias(root, componentsDir, alias) {
  const paths = tsconfigPaths(path.join(componentsDir, 'tsconfig.json'))
  const viaPaths = matchWildcard(paths, alias)
  if (viaPaths) {
    const [first] = [viaPaths.target].flat()
    return viaPaths.exact ? first : directoryOf(first, viaPaths.rest)
  }
  const packages = workspacePackages(root)
  const segments = alias.split('/')
  const name = alias.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const dir = packages.get(name)
  if (dir) {
    const subpath = `.${alias.slice(name.length)}`
    const exports = readJson(path.join(dir, 'package.json')).exports
    if (exports && typeof exports === 'object') {
      const viaExports = matchWildcard(exports, subpath === '.' ? '.' : subpath)
      if (viaExports) {
        const target = typeof viaExports.target === 'string' ? viaExports.target : viaExports.target?.default
        if (typeof target === 'string') {
          return path.resolve(dir, viaExports.exact ? target : directoryOf(target, viaExports.rest))
        }
      }
    }
    return path.resolve(dir, subpath)
  }
  throw new Error(
    `${path.relative(root, path.join(componentsDir, 'components.json'))}: alias "${alias}" resolves through neither tsconfig paths nor a workspace package`,
  )
}

/**
 * Directories, relative to the repository root, that installs write to.
 * `files` is the repository's file list, which is where every components.json
 * is found — one per shadcn root, as many as the repository has.
 */
export function installDirectories(root, files) {
  const dirs = []
  for (const file of files) {
    if (path.basename(file) !== 'components.json') {
      continue
    }
    const componentsDir = path.join(root, path.dirname(file))
    const aliases = readJson(path.join(root, file)).aliases ?? {}
    const targets = INSTALL_ALIASES.filter((key) => typeof aliases[key] === 'string').map((key) => ({
      key,
      resolved: resolveAlias(root, componentsDir, aliases[key]),
    }))
    if (typeof aliases.components === 'string') {
      const components = resolveAlias(root, componentsDir, aliases.components)
      targets.push({ key: 'components/hooks', resolved: path.join(components, 'hooks') })
    }
    for (const { key, resolved } of targets) {
      const dir = path.relative(root, resolved)
      if (dir.startsWith('..') || path.isAbsolute(dir) || dir === '') {
        throw new Error(`${file}: alias "${key}" points outside the repository or at its root (${dir || '.'})`)
      }
      dirs.push({ source: file, alias: key, dir: dir.split(path.sep).join('/') })
    }
  }
  return dirs
}

/** Whether a repository-relative file is one an install wrote. */
export const isInstalled = (dirs, file) => dirs.some(({ dir }) => file.startsWith(`${dir}/`)) && !TEST_FILE.test(file)

/** Split a file list into the files that are the repository's own and the installed ones. */
export function partitionInstalled(root, files) {
  const dirs = installDirectories(root, files)
  const own = []
  const installed = []
  for (const file of files) {
    ;(isInstalled(dirs, file) ? installed : own).push(file)
  }
  return { own, installed, dirs }
}
