// How the types an extension declares become the types the runtime uses — the
// one rule behind both its manifest (_server/manifest.ts) and its client
// declaration (_client/loaded-declaration.ts), so the two halves of one
// extension can never be qualified differently.
//
// An extension declares its node, App and handle types bare; the runtime
// qualifies each with the id the extension runs under. A handle names the type
// it carries bare when it is the extension's own and qualified when it is
// another extension's. Renamed keys are read in their deprecated form where the
// current one is absent.
//
// Safe for both server and client — no runtime imports.

import { isValueType, VALUE_TYPES } from '@opencroft/core/values'

import coreManifest from '@/app/_authed/(extension-runtime)/_builtin/core/extension.json'
import {
  CORE_EXTENSION_ID,
  isSlug,
  parseType,
  qualifyType,
  resolveTypeRef,
} from '@/app/_authed/(extension-runtime)/_extension-id'
import type { ExtensionHandle, ExtensionHandleType } from '@/app/_authed/(extension-runtime)/_types'

// A manifest written for the deprecated `contextType` named handle types from
// one namespace every extension shared, where core's types were the common
// ones. So a bare name under that key means core's type when core declares one
// by that name, and the extension's own otherwise; under `handleType` a bare
// name is always the extension's own.
const CORE_HANDLE_TYPES = new Set(coreManifest.handleTypes.map((handleType) => handleType.id))
const CORE_TYPES = new Set([...coreManifest.nodes.map((node) => node.type), ...CORE_HANDLE_TYPES])

// Each (extension, bare name) is warned about once per process: the client
// resolves on every render of a pin.
const warnedBareCoreRefs = new Set<string>()

/**
 * A node or handle type an extension's code names at runtime: bare for its
 * own, qualified for another's. Code written while every extension's types
 * shared one namespace names core's types bare as well, so a bare name the
 * extension does not declare itself, and core does, is core's. That reading
 * is deprecated and warned about, once per extension and name. `declares`
 * answers whether the extension declares a qualified type.
 */
export function resolveCodeTypeRef(extensionId: string, ref: string, declares: (type: string) => boolean): string {
  const own = resolveTypeRef(extensionId, ref)
  if (!namesCoreType(ref) || declares(own)) {
    return own
  }
  const core = qualifyType(CORE_EXTENSION_ID, ref)
  const key = `${extensionId}\0${ref}`
  if (!warnedBareCoreRefs.has(key)) {
    warnedBareCoreRefs.add(key)
    console.warn(
      `[ext] ${extensionId}: the bare "${ref}" is read as core's type, which is deprecated — name it "${core}"`,
    )
  }
  return core
}

/** Whether `ref` is a bare handle type core declares: what a bare name under the deprecated `contextType` meant. */
export function isCoreHandleType(ref: string): boolean {
  return CORE_HANDLE_TYPES.has(ref)
}

/** Whether `ref` is a bare name core declares: the one case resolveCodeTypeRef asks `declares`. */
export function namesCoreType(ref: string): boolean {
  return isSlug(ref) && CORE_TYPES.has(ref)
}

/** Every node, App and handle type a manifest the runtime has read declares, qualified. */
export function declaredTypesOf(manifest: {
  nodes?: Array<{ type: string }>
  handleTypes?: Array<{ id: string }>
  provides?: { apps?: Array<{ type: string }> }
}): Set<string> {
  return new Set([
    ...(manifest.nodes ?? []).map((node) => node.type),
    ...(manifest.handleTypes ?? []).map((handleType) => handleType.id),
    ...(manifest.provides?.apps ?? []).map((app) => app.type),
  ])
}

/**
 * A handle as declared: `handleType`, or the deprecated `contextType` in its
 * place, and for an input that takes several value types, `accepts`, named
 * as `handleType` is.
 */
interface DeclaredHandle {
  id?: string
  role?: string
  handleType?: string
  contextType?: string
  accepts?: unknown
  acceptsEnums?: unknown
  typeGroup?: unknown
}

/** Anything declared under a bare type: a node (`type`, deprecated `typeId`) or an App (`type`, deprecated `slug`). */
interface DeclaredTyped {
  type?: string
  handles?: DeclaredHandle[]
}

type QualifiedHandle<H> = Omit<H, 'contextType' | 'handleType'> & { handleType: string }

type HandleOf<T> = T extends { handles?: Array<infer H> } ? H : never

type Qualified<T, DeprecatedKey extends string> = Omit<T, 'type' | 'handles' | DeprecatedKey> & {
  type: string
  handles?: QualifiedHandle<HandleOf<T>>[]
}

/**
 * Declared nodes or Apps with their types qualified. `deprecatedKey` is the
 * deprecated key still read as the type (`typeId` for a node, `slug` for an App).
 * Throws, naming the extension, for a type that is not a bare slug or one bare
 * type declared twice.
 */
export function qualifyDeclared<K extends 'typeId' | 'slug', T extends DeclaredTyped & { [key in K]?: string }>(
  extensionId: string,
  what: string,
  deprecatedKey: K,
  entries: T[],
): Qualified<T, K>[] {
  const seen = new Set<string>()
  return entries.map((entry) => {
    const { type, handles, [deprecatedKey]: deprecated, ...rest } = entry
    const bare = bareType(extensionId, what, preferred(extensionId, 'type', type, deprecatedKey, deprecated))
    if (seen.has(bare)) {
      throw new Error(`Extension ${extensionId} declares the ${what} "${bare}" twice`)
    }
    seen.add(bare)
    const qualified = { ...rest, type: qualifyType(extensionId, bare) } as Qualified<T, K>
    if (handles) {
      qualified.handles = handles.map((handle) => qualifyHandle(extensionId, handle)) as QualifiedHandle<HandleOf<T>>[]
    }
    return qualified
  })
}

/**
 * Declared handle types with their ids qualified; the deprecated `contexts` is
 * read where `handleTypes` is absent. Throws, naming the extension and the
 * type, for an enum (`cases`) with no cases, a case value that is not
 * `[A-Za-z0-9_.-]{1,64}`, or one value declared twice.
 */
export function qualifyHandleTypes(
  extensionId: string,
  handleTypes: ExtensionHandleType[] | undefined,
  contexts: ExtensionHandleType[] | undefined,
): ExtensionHandleType[] | undefined {
  return preferred(extensionId, 'handleTypes', handleTypes, 'contexts', contexts)?.map((handleType) => {
    const bare = bareType(extensionId, 'handle type', handleType.id)
    if (handleType.cases !== undefined) {
      checkEnumCases(`Extension ${extensionId} declares the enum "${bare}"`, handleType.cases)
    }
    return { ...handleType, id: qualifyType(extensionId, bare) }
  })
}

const CASE_VALUE = /^[A-Za-z0-9_.-]{1,64}$/

function checkEnumCases(named: string, cases: unknown): void {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`${named} with no cases: cases is a list of { value, label? }`)
  }
  const seen = new Set<string>()
  for (const c of cases) {
    const value = (c as { value?: unknown } | null)?.value
    if (typeof value !== 'string' || !CASE_VALUE.test(value)) {
      throw new Error(`${named} with the case "${String(value)}": a case value is 1 to 64 of A-Z a-z 0-9 _ . -`)
    }
    if (seen.has(value)) {
      throw new Error(`${named} with the case "${value}" twice`)
    }
    seen.add(value)
  }
}

// What a target handle of an enum type may declare of the inline fields: an
// enum's input is a dropdown of its cases, so nothing about a number or a
// text field applies.
const ENUM_INLINE_FIELDS: ReadonlySet<string> = new Set(['inline', 'default'])
const INLINE_FIELDS = ['inline', 'default', 'integer', 'min', 'max', 'step', 'options', 'multiline'] as const

/**
 * Throws, naming the extension and the handle, for a node's handle of one of
 * the extension's own enums that declares an inline field other than
 * `inline` and `default`, or a `default` that is not one of the enum's cases.
 * A handle of another extension's enum is checked where its value is typed.
 */
export function checkEnumHandles(
  extensionId: string,
  handleTypes: readonly ExtensionHandleType[] | undefined,
  nodes: readonly { type: string; handles?: readonly ExtensionHandle[] }[] | undefined,
): void {
  const enums = new Map((handleTypes ?? []).filter((t) => t.cases).map((t) => [t.id, t.cases ?? []]))
  for (const node of nodes ?? []) {
    for (const handle of node.handles ?? []) {
      const cases = enums.get(handle.handleType)
      if (!cases) {
        continue
      }
      const named = `Extension ${extensionId} declares the handle "${handle.id}" of ${node.type}, of the enum ${handle.handleType},`
      const other = INLINE_FIELDS.find((key) => !ENUM_INLINE_FIELDS.has(key) && handle[key] !== undefined)
      if (other) {
        throw new Error(`${named} with ${other}: an enum's input takes only inline and default`)
      }
      if (handle.default !== undefined && !cases.some((c) => c.value === handle.default)) {
        throw new Error(
          `${named} with the default "${String(handle.default)}", which is not one of its cases (${cases.map((c) => c.value).join(', ')})`,
        )
      }
    }
  }
}

function qualifyHandle<H extends DeclaredHandle>(extensionId: string, handle: H): QualifiedHandle<H> {
  const { contextType, handleType, ...rest } = handle
  const ref = preferred(extensionId, 'handleType', handleType, 'contextType', contextType)
  if (ref === undefined || !(isSlug(ref) || parseType(ref))) {
    throw new Error(
      `Extension ${extensionId} declares a handle carrying "${ref ?? ''}": a handle type is the extension's own, bare, or another's, qualified as <owner>.<extension>.<type>`,
    )
  }
  const qualified =
    handleType === undefined && isCoreHandleType(ref)
      ? qualifyType(CORE_EXTENSION_ID, ref)
      : resolveTypeRef(extensionId, ref)
  if (handle.accepts === undefined) {
    return { ...rest, handleType: qualified }
  }
  return { ...rest, handleType: qualified, accepts: qualifyAccepts(extensionId, handle, qualified) }
}

/**
 * The types an input that takes several declares in `accepts`, each named as
 * `handleType` is and qualified the same way. Throws, naming the extension
 * and the handle, for `accepts` on a source handle, one that is not a list of
 * value types, or one without the handle's own `handleType`.
 */
function qualifyAccepts(extensionId: string, handle: DeclaredHandle, handleType: string): string[] {
  const named = `Extension ${extensionId} declares the handle "${handle.id ?? ''}"`
  if (handle.role !== 'target') {
    throw new Error(`${named} with accepts: only an input takes several types`)
  }
  if (!Array.isArray(handle.accepts) || handle.accepts.length === 0) {
    throw new Error(`${named} with accepts that is not a list of the value types it takes`)
  }
  const accepts = handle.accepts.map((ref) => {
    const type = typeof ref === 'string' && (isSlug(ref) || parseType(ref)) ? resolveTypeRef(extensionId, ref) : ''
    if (!isValueType(type)) {
      throw new Error(`${named} accepting "${String(ref)}", which is not a value type (${VALUE_TYPES.join(', ')})`)
    }
    return type
  })
  if (!accepts.includes(handleType)) {
    throw new Error(`${named} with accepts that do not hold its handleType, ${handleType}`)
  }
  if (handle.acceptsEnums !== undefined && typeof handle.acceptsEnums !== 'boolean') {
    throw new Error(`${named} with acceptsEnums that is not true or false`)
  }
  if (handle.typeGroup !== undefined && (typeof handle.typeGroup !== 'string' || handle.typeGroup === '')) {
    throw new Error(`${named} with a typeGroup that is not a name`)
  }
  return accepts
}

/** A declared bare type, refused unless it is a slug: no dot, so the qualified form parses one way. */
function bareType(extensionId: string, what: string, value: string | undefined): string {
  if (value === undefined || !isSlug(value)) {
    throw new Error(
      `Extension ${extensionId} declares the ${what} "${value ?? ''}": a declared type must be a bare slug — lowercase letters, digits and hyphens, no dot`,
    )
  }
  return value
}

/** The value of a renamed key: the current one where present, the deprecated one otherwise. */
function preferred<T>(
  extensionId: string,
  key: string,
  current: T | undefined,
  deprecatedKey: string,
  deprecated: T | undefined,
): T | undefined {
  if (current !== undefined && deprecated !== undefined && JSON.stringify(current) !== JSON.stringify(deprecated)) {
    console.warn(
      `[ext] ${extensionId}: "${key}" and the deprecated "${deprecatedKey}" disagree; "${key}" is used — drop "${deprecatedKey}"`,
    )
  }
  return current ?? deprecated
}
