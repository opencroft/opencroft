// Typechecking one extension checkout. Shared by the core app's typecheck of
// an instance's extension folders (apps/opencroft/scripts/typecheck-extensions.mjs)
// and by `opencroft-dev typecheck` in an extension repository, so the two
// cannot come to disagree about what "typechecks" means.
//
// An extension compiles against its host: `@opencroft/client`,
// `@opencroft/server`, React and the host's ambient types resolve only from
// inside a core tree, which is where an instance keeps its extensions. So the
// checkout has to sit there when tsc reads it.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The deprecated specifiers an extension can still import: the compiler serves
// them, and `@opencroft/client` / `@opencroft/server` and their modules are
// the contract that replaces them.
export const DEPRECATED_SPECIFIERS = /['"]@ext\/(host|ui)['"]/

// Their declarations: every name re-exported from the module that owns it now,
// tagged `@deprecated`, generated in the client package. Part of every project
// this file writes, so a file still on them is typechecked like any other.
export const DEPRECATED_MODULE_DECLARATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'client',
  'ext-modules.d.ts',
)

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git'])

/**
 * The checker, resolved to a path rather than left to `npx tsc`.
 *
 * `npx` with no local install does not fail: it fetches an unrelated registry
 * package of that name and runs it, which for a checker means no diagnostics
 * and exit 0 -- a clean report from something that never read the code. The
 * whole output of a typecheck is an absence, so it has to carry positive proof
 * of what produced it. Hence the path, and hence the version printed beside the
 * results.
 */
export function resolveTsc(startDir) {
  let dir = startDir
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

export const tscVersion = (tsc) =>
  spawnSync(tsc, ['--version'], { encoding: 'utf8' })
    .stdout?.trim()
    .replace(/^Version\s+/, '')

/** Every TypeScript source file in a checkout, ignoring dependencies and build output. */
export function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
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

export function filesOnDeprecatedSpecifiers(files) {
  return files.filter((file) => DEPRECATED_SPECIFIERS.test(readFileSync(file, 'utf8')))
}

/**
 * Where tsc finds the `types` a project names when it is given no
 * `typeRoots`: every `node_modules/@types` from `dir` up to the root, nearest
 * first, and then a name with a path in it (`vite/client`) as a package in the
 * nearest `node_modules` that has it.
 */
function typeRootsFrom(dir) {
  const ancestors = []
  for (let at = dir; ; at = path.dirname(at)) {
    ancestors.push(path.join(at, 'node_modules'))
    if (path.dirname(at) === at) {
      break
    }
  }
  return [...ancestors.map((modules) => path.join(modules, '@types')), ...ancestors].filter((root) => existsSync(root))
}

/**
 * A project file that is `project` plus the deprecated modules' declarations,
 * for a repository that brings a check project of its own.
 *
 * The wrapper lives in `outDir`, and tsc finds a project's default type roots
 * from the directory of the project it was given: from there it would read the
 * core's `@types` (its `@types/node`, say) over the repository's own. So unless
 * the repository's project sets `typeRoots` itself (read with `--showConfig`,
 * which follows `extends`), the wrapper names the roots tsc would have found
 * from that project's own directory.
 */
export function withDeprecatedModules(tsc, project, slug, outDir) {
  const shown = spawnSync(tsc, ['--showConfig', '-p', project], { encoding: 'utf8' })
  const ownRoots = shown.status === 0 && JSON.parse(shown.stdout).compilerOptions?.typeRoots !== undefined
  const wrapper = path.join(outDir, `${slug}.with-deprecated-modules.json`)
  const config = {
    extends: project,
    ...(ownRoots ? {} : { compilerOptions: { typeRoots: typeRootsFrom(path.dirname(project)) } }),
    files: [DEPRECATED_MODULE_DECLARATIONS],
  }
  writeFileSync(wrapper, `${JSON.stringify(config, null, 2)}\n`)
  return wrapper
}

/**
 * The tsconfig the check runs with, written to `outDir` rather than inside the
 * extension: a checkout is a separate repository, and on a deployed instance it
 * is shared, so this must not put a file in one. `outDir` has to sit inside the
 * core tree, because `types` resolve from the project file's own location.
 *
 * It extends the extension's own tsconfig when there is one, so a repository
 * keeps its path aliases, and pins the options the check itself depends on.
 * `baseUrl` is the checkout, which is what makes an inherited relative `paths`
 * entry resolve against the repository that wrote it.
 */
export function writeProjectFile(slug, dir, outDir) {
  const own = path.join(dir, 'tsconfig.json')
  const project = {
    ...(existsSync(own) ? { extends: own } : {}),
    compilerOptions: {
      target: 'ES2022',
      lib: ['dom', 'dom.iterable', 'esnext'],
      module: 'esnext',
      moduleResolution: 'bundler',
      // What the host's extension compiler builds with (esbuild `jsx:
      // 'automatic'`). `preserve` looks for a global JSX namespace, which
      // React 19's types do not declare, so every element would read as `any`.
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      // Extension tests run under `node --experimental-strip-types`, which
      // needs the `.ts` on a relative import.
      allowImportingTsExtensions: true,
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
    files: [DEPRECATED_MODULE_DECLARATIONS],
    include: [path.join(dir, '**/*.ts'), path.join(dir, '**/*.tsx')],
    exclude: [path.join(dir, 'node_modules'), path.join(dir, 'dist')],
  }
  const file = path.join(outDir, `${slug}.json`)
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`)
  return file
}

const DIAGNOSTIC = /^(.+?)\((\d+),\d+\): (error TS\d+: .*)$/

/**
 * Run tsc and split what it says into this extension's diagnostics and the rest.
 *
 * A diagnostic against a host package is that package's own business -- it
 * typechecks itself, and its source is only in this program because an
 * extension imports it. Counted and dropped rather than silently ignored, the
 * same rule run-typecheck.mjs follows for the same reason.
 *
 * Each own diagnostic comes back as its file (relative to the checkout), its
 * line and its message.
 */
export function runTsc(tsc, projectFile, dir) {
  const result = spawnSync(tsc, ['--noEmit', '-p', projectFile], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const own = []
  const foreign = []
  const unparsed = []
  for (const line of output.split('\n').filter((value) => value.length > 0)) {
    const match = line.match(DIAGNOSTIC)
    if (match) {
      const [, file, row, message] = match
      const absolute = path.resolve(dir, file)
      if (absolute.startsWith(`${dir}${path.sep}`)) {
        own.push({ file: path.relative(dir, absolute).split(path.sep).join('/'), line: Number(row), message })
      } else {
        foreign.push(`${absolute}: ${message}`)
      }
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
