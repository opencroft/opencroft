/**
 * The node types a graph can hold: every type an installed extension's
 * manifest declares, as listNodeTypes shows them and as createNodes checks a
 * requested type against. A type nothing declares would be stored as a node no
 * extension renders or runs, so it is refused with the nearest registered ones.
 */

import {
  type AcceptedTypes,
  type EnumCasesOf,
  type InlineValueFields,
  isEnumHandle,
  isPrimitiveType,
  type ValueOption,
  withEnumCases,
} from '@opencroft/core/values'

import { enumCasesOfManifests } from '@/app/_authed/(extension-runtime)/_enum-types'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import type { ExtensionHandle, NodeMetadata } from '@/app/_authed/(extension-runtime)/_types'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'

export interface RegisteredNodeType {
  extensionId: string
  extensionName: string
  node: NodeMetadata
}

/** The enums the installed extensions declare (see `enumCasesOfManifests`). */
export async function readEnumCases(): Promise<EnumCasesOf> {
  return enumCasesOfManifests(await loadAllManifests())
}

/** Every registered node type, keyed by the qualified type graphs store. */
export async function readNodeTypes(): Promise<Map<string, RegisteredNodeType>> {
  const types = new Map<string, RegisteredNodeType>()
  for (const manifest of await loadAllManifests()) {
    for (const node of manifest.nodes ?? []) {
      types.set(node.type, { extensionId: manifest.id, extensionName: manifest.name, node })
    }
  }
  return types
}

interface HandleView extends InlineValueFields, AcceptedTypes {
  id: string
  handleType: string
  label?: string
  dynamic?: true
  multiple?: true
  runtime?: true
  /** The cases of the enum the handle carries. */
  cases?: ValueOption[]
}

const INLINE_FIELDS = [
  'inline',
  'default',
  'integer',
  'min',
  'max',
  'step',
  'options',
  'multiline',
  'accepts',
  'acceptsEnums',
  'typeGroup',
] as const

// A primitive or enum input also shows what may be typed into it
// (`data.inputs.<id>`), and, when it takes several types, which (its
// `handleType` is then the one it has before anything is connected).
function inlineFieldsOf(handle: ExtensionHandle): InlineValueFields & AcceptedTypes {
  if (handle.role !== 'target' || !(isPrimitiveType(handle.handleType) || isEnumHandle(handle))) {
    return {}
  }
  return Object.fromEntries(INLINE_FIELDS.filter((key) => handle[key] !== undefined).map((key) => [key, handle[key]]))
}

function handleView(handle: ExtensionHandle): HandleView {
  const { id, handleType, label, dynamic, multiple, runtime, role, cases } = handle
  return {
    id,
    handleType,
    ...(label ? { label } : {}),
    ...(dynamic ? { dynamic: true } : {}),
    ...(multiple && role === 'target' ? { multiple: true } : {}),
    ...(runtime && role === 'source' ? { runtime: true } : {}),
    ...(cases ? { cases: [...cases] } : {}),
    ...inlineFieldsOf(handle),
  }
}

/** One type as listNodeTypes returns it; a handle of an enum type with the enum's `cases`. */
export function nodeTypeView(entry: RegisteredNodeType, enumCasesOf: EnumCasesOf) {
  const { node } = entry
  const handles = withEnumCases(node.handles ?? [], enumCasesOf)
  return {
    type: node.type,
    label: node.name,
    extension: entry.extensionId,
    extensionName: entry.extensionName,
    ...(node.category ? { category: node.category } : {}),
    ...(node.description ? { description: node.description } : {}),
    handles: {
      input: handles.filter((h) => h.role === 'target').map(handleView),
      output: handles.filter((h) => h.role === 'source').map(handleView),
    },
  }
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

const MAX_SUGGESTIONS = 3

/**
 * The registered types closest to `wanted`, nearest first, compared by bare
 * name so the right name under the wrong extension is found, and a long shared
 * extension prefix does not make unrelated names look close. A bare name that
 * contains the wanted one, or is contained in it (`core-key-store` for
 * `key-store`), comes first; then names within a third of the wanted name's
 * length in edits, enough for a typo without offering every short name. Ties
 * go to the extension `wanted` names.
 */
export function suggestNodeTypes(wanted: string, registered: Iterable<string>): string[] {
  const lower = wanted.toLowerCase()
  const parsed = parseType(lower)
  const wantedBare = parsed?.bare ?? lower.split('.').at(-1) ?? lower
  const limit = Math.max(1, Math.floor(wantedBare.length / 3))
  const scored: Array<{ type: string; contains: boolean; distance: number; sameExtension: boolean }> = []
  for (const type of registered) {
    const candidate = parseType(type)
    const bare = (candidate?.bare ?? type).toLowerCase()
    const contains =
      Math.min(wantedBare.length, bare.length) >= 3 && (bare.includes(wantedBare) || wantedBare.includes(bare))
    const distance = editDistance(wantedBare, bare)
    if (contains || distance <= limit) {
      scored.push({ type, contains, distance, sameExtension: candidate?.extensionId === parsed?.extensionId })
    }
  }
  scored.sort(
    (a, b) =>
      Number(b.contains) - Number(a.contains) ||
      a.distance - b.distance ||
      Number(b.sameExtension) - Number(a.sameExtension),
  )
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.type)
}

function quoted(types: string[]): string {
  return types.map((t) => `"${t}"`).join(', ')
}

// What to try instead: the nearest types, else the named extension's own
// types, else that the extension is not installed.
function refusalHint(type: string, types: Map<string, RegisteredNodeType>): string {
  const suggestions = suggestNodeTypes(type, types.keys())
  if (suggestions.length > 0) {
    return `Did you mean ${quoted(suggestions)}?`
  }
  const extensionId = parseType(type)?.extensionId
  const ofExtension = [...types.values()].filter((t) => t.extensionId === extensionId).map((t) => t.node.type)
  if (ofExtension.length > 0) {
    return `${extensionId} provides ${quoted(ofExtension)}.`
  }
  return extensionId ? `No installed extension is ${extensionId}.` : ''
}

/**
 * Refuses, in one answer, every requested type that is malformed or that no
 * installed extension declares. Each line says what to try instead.
 */
export function requireRegisteredTypes(requested: string[], types: Map<string, RegisteredNodeType>): void {
  const problems: string[] = []
  for (const type of new Set(requested)) {
    if (types.has(type)) {
      continue
    }
    // A bare name is wrong in form, not only unregistered: no extension can declare it.
    const problem = parseType(type)
      ? `No node type "${type}".`
      : `"${type}" is not a qualified node type: expected <owner>.<extension>.<type>.`
    problems.push([problem, refusalHint(type, types)].filter(Boolean).join(' '))
  }
  if (problems.length > 0) {
    fail(-32602, `${problems.join('\n')}\nlistNodeTypes lists every node type this instance provides.`)
  }
}
