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

import coreManifest from '@/app/_authed/(extension-runtime)/_builtin/core/extension.json'
import {
  CORE_EXTENSION_ID,
  isSlug,
  parseType,
  qualifyType,
  resolveTypeRef,
} from '@/app/_authed/(extension-runtime)/_extension-id'
import type { ExtensionHandleType } from '@/app/_authed/(extension-runtime)/_types'

// A manifest written for the deprecated `contextType` named handle types from
// one namespace every extension shared, where core's types were the common
// ones. So a bare name under that key means core's type when core declares one
// by that name, and the extension's own otherwise; under `handleType` a bare
// name is always the extension's own.
const CORE_HANDLE_TYPES = new Set(coreManifest.handleTypes.map((handleType) => handleType.id))
const CORE_TYPES = new Set([...coreManifest.nodes.map((node) => node.type), ...CORE_HANDLE_TYPES])

/**
 * A node or handle type an extension's code names at runtime: bare for its
 * own, qualified for another's. Code written while every extension's types
 * shared one namespace names core's types bare as well, so a bare name the
 * extension does not declare itself, and core does, is core's. `declares`
 * answers whether the extension declares a qualified type.
 */
export function resolveCodeTypeRef(extensionId: string, ref: string, declares: (type: string) => boolean): string {
  const own = resolveTypeRef(extensionId, ref)
  return namesCoreType(ref) && !declares(own) ? qualifyType(CORE_EXTENSION_ID, ref) : own
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

/** A handle as declared: `handleType`, or the deprecated `contextType` in its place. */
interface DeclaredHandle {
  handleType?: string
  contextType?: string
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

/** Declared handle types with their ids qualified; the deprecated `contexts` is read where `handleTypes` is absent. */
export function qualifyHandleTypes(
  extensionId: string,
  handleTypes: ExtensionHandleType[] | undefined,
  contexts: ExtensionHandleType[] | undefined,
): ExtensionHandleType[] | undefined {
  return preferred(extensionId, 'handleTypes', handleTypes, 'contexts', contexts)?.map((handleType) => ({
    ...handleType,
    id: qualifyType(extensionId, bareType(extensionId, 'handle type', handleType.id)),
  }))
}

function qualifyHandle<H extends DeclaredHandle>(extensionId: string, handle: H): QualifiedHandle<H> {
  const { contextType, handleType, ...rest } = handle
  const ref = preferred(extensionId, 'handleType', handleType, 'contextType', contextType)
  if (ref === undefined || !(isSlug(ref) || parseType(ref))) {
    throw new Error(
      `Extension ${extensionId} declares a handle carrying "${ref ?? ''}": a handle type is the extension's own, bare, or another's, qualified as <owner>.<extension>.<type>`,
    )
  }
  if (handleType === undefined && CORE_HANDLE_TYPES.has(ref)) {
    return { ...rest, handleType: qualifyType(CORE_EXTENSION_ID, ref) }
  }
  return { ...rest, handleType: resolveTypeRef(extensionId, ref) }
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
