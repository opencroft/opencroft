import { promises as fs } from 'node:fs'
import path from 'node:path'

import { isCoreHandleType } from '@/app/_authed/(extension-runtime)/_declared-types'
import { CORE_EXTENSION_ID, qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { Deprecation } from '@/app/_authed/(extension-runtime)/_server/deprecations'
import { MANIFEST_FILE } from '@/app/_authed/(extension-runtime)/_server/extension-folders'

/*
 * Types an extension declares under a renamed key — `typeId`, `slug`,
 * `contexts`, `contextType` — in its manifest and in the client declaration
 * its build bundled, and handle pins naming one of core's handle types bare.
 * The runtime still reads all of them (_declared-types.ts); each is reported
 * so the author can move to the current key.
 *
 * The manifest is data, so what it declares is read exactly; the line given is
 * the key's matching occurrence in the text. The client declaration is code,
 * read with patterns as extension-api-deprecations.ts reads imports: a key
 * counts only with a value of the shape a declaration gives it (a string
 * literal, or an array for `contexts`), and `slug` only inside an `apps` array,
 * since an App instance's `slug` is current. A miss costs a warning, never a
 * build.
 */

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length

/** What replaces `contextType: ref`, declared under `key` (`handleType`, or its path in a manifest). */
function handleTypeReplacement(ref: string, key = 'handleType'): string {
  return isCoreHandleType(ref)
    ? `declare \`${key}: "${qualifyType(CORE_EXTENSION_ID, ref)}"\` — under \`handleType\` a bare name is the extension's own`
    : `declare \`${key}\``
}

// Where a renamed key declares something in a manifest, by its path.
const MANIFEST_KEYS: { path: RegExp; current: string }[] = [
  { path: /^contexts$/, current: 'handleTypes' },
  { path: /^nodes\[\d+\]\.typeId$/, current: 'type' },
  { path: /^provides\.apps\[\d+\]\.slug$/, current: 'type' },
  { path: /^(?:nodes|provides\.apps)\[\d+\]\.handles\[\d+\]\.contextType$/, current: 'handleType' },
]

const RENAMED = new Set(['contexts', 'typeId', 'slug', 'contextType'])

interface KeyAt {
  key: string
  path: string
  value: unknown
}

/** Every renamed key anywhere in `value`, in document order, with its path. */
function renamedKeys(value: unknown, at: string, found: KeyAt[]): KeyAt[] {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      renamedKeys(item, `${at}[${index}]`, found)
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = at ? `${at}.${key}` : key
      if (RENAMED.has(key)) {
        found.push({ key, path: childPath, value: child })
      }
      renamedKeys(child, childPath, found)
    }
  }
  return found
}

function scanManifest(text: string, manifest: unknown): Deprecation[] {
  const found = renamedKeys(manifest, '', [])
  // The n-th occurrence of a key in the data is its n-th occurrence as a key
  // in the text; where the counts differ (a duplicate key) no line is given.
  const linesOf = (key: string) => {
    const lines = [...text.matchAll(new RegExp(`(?<!\\\\)"${key}"\\s*:`, 'g'))].map((match) =>
      lineOf(text, match.index),
    )
    return lines.length === found.filter((entry) => entry.key === key).length ? lines : []
  }
  const lines = new Map([...RENAMED].map((key) => [key, linesOf(key)]))
  const seen = new Map<string, number>()
  const deprecations: Deprecation[] = []
  for (const { key, path: keyPath, value } of found) {
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    const declared = MANIFEST_KEYS.find((entry) => entry.path.test(keyPath))
    if (!declared) {
      continue
    }
    const currentPath = keyPath.replace(/[\w$]+$/, declared.current)
    deprecations.push({
      file: MANIFEST_FILE,
      line: lines.get(key)?.[occurrence],
      used: `\`${keyPath}\``,
      replacement:
        key === 'contextType' && typeof value === 'string'
          ? handleTypeReplacement(value, currentPath)
          : `declare \`${currentPath}\``,
    })
  }
  return deprecations
}

/** The end of the bracketed span opening at `open`, skipping string literals; the source's end when unclosed. */
function closingBracket(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      const end = source.indexOf(char, index + 1)
      index = end === -1 ? source.length : end
    } else if (char === '[' || char === '{' || char === '(') {
      depth++
    } else if (char === ']' || char === '}' || char === ')') {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }
  return source.length
}

const TYPE_ID = /\btypeId\s*:\s*['"`]/g
const CONTEXT_TYPE = /\bcontextType\s*:\s*(['"`])([^'"`\n]*)\1/g
const CONTEXTS = /\bcontexts\s*:\s*\[/g
const APPS = /\bapps\s*:\s*\[/g
const SLUG = /\bslug\s*:\s*['"`]/g
const HANDLE_PIN = /<(InputHandle|OutputHandle)\b[^>]*?\btype\s*=\s*\{?\s*(['"`])([\w-]+)\2/g

/** `ownHandleTypes`: the bare handle types the manifest declares, which a pin names bare as the extension's own. */
function scanClientSource(file: string, source: string, ownHandleTypes: ReadonlySet<string>): Deprecation[] {
  const at = (index: number) => ({ file, line: lineOf(source, index) })
  const found: Deprecation[] = []
  for (const match of source.matchAll(TYPE_ID)) {
    found.push({ ...at(match.index), used: '`typeId`', replacement: "declare the node's type under `type`" })
  }
  for (const match of source.matchAll(CONTEXT_TYPE)) {
    found.push({ ...at(match.index), used: '`contextType`', replacement: handleTypeReplacement(match[2]) })
  }
  for (const match of source.matchAll(CONTEXTS)) {
    found.push({ ...at(match.index), used: '`contexts`', replacement: 'declare the handle types under `handleTypes`' })
  }
  for (const apps of source.matchAll(APPS)) {
    const open = apps.index + apps[0].length - 1
    const span = source.slice(open, closingBracket(source, open))
    for (const match of span.matchAll(SLUG)) {
      found.push({ ...at(open + match.index), used: '`slug`', replacement: "declare the App's type under `type`" })
    }
  }
  for (const match of source.matchAll(HANDLE_PIN)) {
    const [, component, , ref] = match
    if (isCoreHandleType(ref) && !ownHandleTypes.has(ref)) {
      found.push({
        ...at(match.index),
        used: `\`${component} type="${ref}"\``,
        replacement: `name core's handle type qualified, \`"${qualifyType(CORE_EXTENSION_ID, ref)}"\` — a bare name is read as core's only for compatibility`,
      })
    }
  }
  return found
}

/**
 * Every deprecated key the manifest at `sourceDir` and the client sources a
 * build bundled declare (relative to `sourceDir`), by file and line.
 */
export async function scanDeprecatedManifestKeys(sourceDir: string, clientFiles: string[]): Promise<Deprecation[]> {
  const found: Deprecation[] = []
  const text = await fs.readFile(path.join(sourceDir, MANIFEST_FILE), 'utf-8').catch(() => null)
  let manifest: { handleTypes?: unknown; contexts?: unknown } | null = null
  try {
    manifest = text === null ? null : JSON.parse(text)
  } catch {
    // An unreadable manifest is reported where it is read, not here.
  }
  if (text !== null && manifest !== null) {
    found.push(...scanManifest(text, manifest))
  }
  const declaredHandleTypes = manifest?.handleTypes ?? manifest?.contexts
  const ownHandleTypes = new Set(
    Array.isArray(declaredHandleTypes) ? declaredHandleTypes.map((handleType) => handleType?.id) : [],
  )
  for (const file of clientFiles.filter((name) => /\.[jt]sx?$/.test(name) && !name.includes('node_modules'))) {
    const source = await fs.readFile(path.resolve(sourceDir, file), 'utf-8').catch(() => null)
    if (source !== null) {
      found.push(...scanClientSource(file, source, ownHandleTypes))
    }
  }
  return found
}
