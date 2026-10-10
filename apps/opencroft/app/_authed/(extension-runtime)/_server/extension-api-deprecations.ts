import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { Deprecation } from '@/app/_authed/(extension-runtime)/_server/deprecations'

const require = createRequire(import.meta.url)

/*
 * Uses of the deprecated extension API surface in an extension's sources:
 * imports of `@ext/host` and `@ext/ui`, and of the `legacy` namespace of
 * `@opencroft/client` or `@opencroft/server` — each with the names the file
 * takes from it and where each of those lives now.
 *
 * Read from the source files a build actually bundled, after the build has
 * settled (for the reason scanIconUsage in compiler.ts gives), with patterns
 * rather than a parser — the same trade that scan makes. What a pattern can
 * miss is a use the author spelled unusually; what it costs is a missing
 * warning, never a failed build.
 */

export type BuildSide = 'client' | 'server'

/** The source files one side of a build bundled, relative to the extension's folder. */
export interface BundledSources {
  side: BuildSide
  files: string[]
}

// `import x, { a, type B, c as d } from '<spec>'`, `import * as x from`,
// `export { a } from`. The clause holds no quote, semicolon or parenthesis,
// which keeps a match from running across statements.
const STATIC_IMPORT =
  /\b(?:import|export)\s+(type\s+)?([^;'"()]*?)\s*from\s*['"](@ext\/(?:host|ui)|@opencroft\/(?:client|server))['"]/g
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"](@ext\/(?:host|ui))['"]\s*\)/g

interface ImportClause {
  defaultName?: string
  namespace?: string
  /** Imported names (as exported), each with whether it is type-only and its local name. */
  named: { name: string; local: string; isType: boolean }[]
}

function parseClause(clause: string, typeOnly: boolean): ImportClause {
  const result: ImportClause = { named: [] }
  const braces = clause.match(/\{([^}]*)\}/)
  if (braces) {
    for (const raw of braces[1].split(',')) {
      const part = raw.trim()
      if (!part) {
        continue
      }
      const isType = typeOnly || part.startsWith('type ')
      const [name, local] = part
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .map((piece) => piece.trim())
      result.named.push({ name, local: local ?? name, isType })
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, '').trim()
  const namespace = rest.match(/\*\s*as\s+([\w$]+)/)
  if (namespace) {
    result.namespace = namespace[1]
  }
  const defaultName = rest.match(/^([\w$]+)/)
  if (defaultName && defaultName[1] !== 'type') {
    result.defaultName = defaultName[1]
  }
  return result
}

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length

/**
 * The `@deprecated` tag of every name in a package's `legacy` namespace, by
 * name: "Import `NodeFrame` from `@opencroft/client/canvas`.", "Use
 * `import { toast } from 'sonner'`.". The same generated file an editor reads
 * its strike-through from, so a build warning and an editor hint say the same.
 */
type Tags = Map<string, string>

const DEPRECATED_TAG = /\/\*\* @deprecated (.+?) \*\/\s*(?:type\s+)?(?:[\w$]+\s+as\s+)?([\w$]+),/g

// `null` when the package's `legacy.ts` could not be read: which names it
// tags is then unknown, which is not the same as it tagging none.
const tagsByPackage = new Map<BuildSide, Promise<Tags | null>>()

function legacyTags(pkg: BuildSide): Promise<Tags | null> {
  let tags = tagsByPackage.get(pkg)
  if (!tags) {
    // The package root resolves to `src/index.ts`; `legacy.ts` sits beside it.
    const legacyFile = path.join(path.dirname(require.resolve(`@opencroft/${pkg}`)), 'legacy.ts')
    tags = fs.readFile(legacyFile, 'utf-8').then(
      (source) => new Map([...source.matchAll(DEPRECATED_TAG)].map((match) => [match[2], match[1]])),
      // Reporting must never fail a build: without the tags every use is
      // still reported, only without naming each name's module.
      (error: unknown) => {
        console.warn(`[ext] ${legacyFile} unreadable, deprecations name no modules:`, error)
        return null
      },
    )
    tagsByPackage.set(pkg, tags)
  }
  return tags
}

const backticked = (names: string[]) => names.map((name) => `\`${name}\``).join(', ')

const MOVED = /^Import `[\w$]+` from (`[^`]+`)\.$/

/**
 * "import `a`, `b` from `@opencroft/client/canvas`; `icons`: use each icon by
 * name from `lucide-react`" — the names grouped by where each now comes from.
 * Without the tags, the names alone: whether each is part of the package is
 * then as unknown as its module.
 */
function replacementFor(names: string[], tags: Tags | null, pkg: BuildSide): string {
  const sorted = [...new Set(names)].sort()
  if (tags === null) {
    return `import ${backticked(sorted)} each from its module of \`@opencroft/${pkg}\``
  }
  const byModule = new Map<string, string[]>()
  const other: string[] = []
  const unplaced: string[] = []
  for (const name of sorted) {
    const tag = tags.get(name)
    const module = tag?.match(MOVED)?.[1]
    if (module) {
      byModule.set(module, [...(byModule.get(module) ?? []), name])
    } else if (tag) {
      other.push(`\`${name}\`: ${tag.replace(/\.$/, '').replace(/^Use /, 'use ')}`)
    } else {
      unplaced.push(name)
    }
  }
  const parts = [
    ...[...byModule.entries()].map(([module, moduleNames]) => `import ${backticked(moduleNames)} from ${module}`),
    ...other,
  ]
  if (unplaced.length > 0) {
    parts.push(`${backticked(unplaced)}: not part of \`@opencroft/${pkg}\``)
  }
  return parts.join('; ')
}

const WHOLE_HOST: Record<BuildSide, string> = {
  client: 'import each name from its module of `@opencroft/client` (`@opencroft/client/canvas`, …)',
  server:
    'import each capability from its module of `@opencroft/server` (`graph` from `@opencroft/server/graph`, …), or the whole host as the default export of `@opencroft/server`',
}

/** The names a file takes from a namespace bound to `local`: `local.x` and `const { x } = local`. */
function namesReadFrom(source: string, local: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(new RegExp(`\\b${local}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
    names.add(match[1])
  }
  for (const match of source.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${local}\\b`, 'g'))) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(':')[0].trim()
      if (name && !name.startsWith('...')) {
        names.add(name)
      }
    }
  }
  return [...names]
}

/**
 * The deprecated uses in one file, built for `side`. `@ext/host` is the
 * client host in a client build and the server host in a server build, so
 * its names are placed by that side's package.
 */
function scanFile(file: string, source: string, side: BuildSide, tags: Record<BuildSide, Tags | null>): Deprecation[] {
  const found: Deprecation[] = []
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const [, typeOnly, clause, specifier] = match
    const line = lineOf(source, match.index)
    const parsed = parseClause(clause, Boolean(typeOnly))
    if (specifier.startsWith('@opencroft/')) {
      // The package roots are not deprecated; their `legacy` namespace is.
      const legacy = parsed.named.find((entry) => entry.name === 'legacy')
      if (legacy) {
        const pkg: BuildSide = specifier === '@opencroft/server' ? 'server' : 'client'
        const used = namesReadFrom(source, legacy.local)
        found.push({
          file,
          line,
          used: `\`legacy\` from \`${specifier}\``,
          replacement:
            used.length > 0
              ? replacementFor(used, tags[pkg], pkg)
              : `import each name from its module of \`${specifier}\``,
        })
      }
      continue
    }
    const parts: string[] = []
    if (parsed.named.length > 0) {
      parts.push(
        replacementFor(
          parsed.named.map((entry) => entry.name),
          tags[side],
          side,
        ),
      )
    }
    for (const local of [parsed.defaultName, parsed.namespace].filter((name): name is string => Boolean(name))) {
      const read = namesReadFrom(source, local)
      parts.push(read.length > 0 ? replacementFor(read, tags[side], side) : WHOLE_HOST[side])
    }
    found.push({
      file,
      line,
      used: `\`${specifier}\``,
      replacement: parts.length > 0 ? parts.join('; ') : WHOLE_HOST[side],
    })
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    found.push({ file, line: lineOf(source, match.index), used: `\`${match[1]}\``, replacement: WHOLE_HOST[side] })
  }
  return found
}

/** Every use of the deprecated surface in the files a build bundled, once per file, line and message. */
export async function scanDeprecatedApiUses(sourceDir: string, sides: BundledSources[]): Promise<Deprecation[]> {
  const found = new Map<string, Deprecation>()
  const tags = { client: await legacyTags('client'), server: await legacyTags('server') }
  for (const { side, files } of sides) {
    const ownFiles = files.filter((file) => /\.[jt]sx?$/.test(file) && !file.includes('node_modules'))
    for (const file of ownFiles) {
      const source = await fs.readFile(path.resolve(sourceDir, file), 'utf-8').catch(() => null)
      if (source === null) {
        continue
      }
      for (const deprecation of scanFile(file, source, side, tags)) {
        found.set(`${deprecation.file}:${deprecation.line}:${deprecation.used}:${deprecation.replacement}`, deprecation)
      }
    }
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0))
}
