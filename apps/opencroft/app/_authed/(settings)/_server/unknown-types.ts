// The instance-wide check of which node, app and handle types are in use but
// provided by no installed extension, and the two ways out of that state:
// install the extension a type names, or rewrite every use of the type to one
// that exists. Session-free; the admin gate sits on the server functions in
// unknown-types-actions.ts.
//
// Nothing here deletes anything. A replace rewrites types in place, through
// the same stores the canvas and the app runtime write through.

import { db, spaceApp } from '@opencroft/db'
import { asc, eq } from 'drizzle-orm'

import { providedApps } from '@/app/_authed/(apps)/_server/host-apps'
import { retypeSpaceAppImpl } from '@/app/_authed/(apps)/_server/runtime'
import { extensionIdOfType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { GraphEdgeRecord, GraphNodeRecord } from '@/app/_authed/(extension-runtime)/_server/host'
import { loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { fetchAllRegistries, getRegistrySources } from '@/app/_authed/(extension-runtime)/_server/registry'
import {
  type ExtensionHandle,
  type ExtensionManifest,
  findExtensionHandle,
} from '@/app/_authed/(extension-runtime)/_types'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import type { GraphRef } from '@/app/_authed/(space)/_server/store'

export type TypeKind = 'node' | 'app' | 'handle'

/** A kind whose uses the instance stores, and can therefore rewrite. */
export type ReplaceableKind = Exclude<TypeKind, 'handle'>

/** One place a type is used. */
export interface TypeUsage {
  /** What uses it: a node, an app instance, or for a handle type the node or app declaring the handle. */
  label: string
  /** Where that is: space and graph, space, or the declaring extension. */
  location: string
  /** The page it is on, when it has one. */
  href?: string
}

export interface UnknownType {
  kind: TypeKind
  type: string
  usages: TypeUsage[]
  /** A registry listing the extension this type names. Only a qualified type names one. */
  install?: { extensionId: string; registryName: string }
}

/** A type an unknown one of the same kind can be replaced with. */
export interface KnownType {
  kind: ReplaceableKind
  type: string
  /** Display name from the providing extension's manifest. */
  label: string
  extensionName: string
}

export interface TypeScan {
  unknown: UnknownType[]
  replacements: KnownType[]
  /**
   * Registries that could not be read, by name. Without it, a type with no
   * install offer would read as "no registry has it" when that registry was
   * never read. Absent when no type names an extension, since no registry is
   * asked then.
   */
  unreachableRegistries?: string[]
}

/** The extension ids every registry lists, and the registries that could not be read. */
export interface RegistryListing {
  extensions: Array<{ id: string; registryName: string }>
  unreachable: string[]
}

export interface ReplaceRequest {
  kind: ReplaceableKind
  from: string
  to: string
}

/** An edge whose handle the replacement type does not declare. It is kept, and renders as a stale handle. */
export interface StaleEdge {
  location: string
  node: string
  handle: string
}

export interface ReplacePlan {
  count: number
  staleEdges: StaleEdge[]
}

export interface ReplaceResult {
  replaced: number
  /** Graphs or app instances left unchanged, and apps retyped whose new App then failed to load. */
  failures: Array<{ location: string; error: string }>
}

interface KnownNode extends KnownType {
  handles: ExtensionHandle[]
}

interface Catalog {
  manifests: ExtensionManifest[]
  nodes: Map<string, KnownNode>
  apps: Map<string, KnownType>
  handles: Set<string>
}

/**
 * Every type the installed extensions provide, from their manifests as the
 * runtime reads them — so in the qualified form graphs and app instances store:
 * what the server knows exists.
 */
async function readCatalog(): Promise<Catalog> {
  const manifests = await loadAllManifests()
  const nodes = new Map<string, KnownNode>()
  const handles = new Set<string>()
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      nodes.set(node.type, {
        kind: 'node',
        type: node.type,
        label: node.name,
        extensionName: manifest.name,
        handles: node.handles ?? [],
      })
    }
    for (const handleType of manifest.handleTypes ?? []) {
      handles.add(handleType.id)
    }
  }
  const nameOf = new Map(manifests.map((manifest) => [manifest.id, manifest.name]))
  const apps = new Map<string, KnownType>()
  for (const { extensionId, value } of await providedApps()) {
    apps.set(value.type, {
      kind: 'app',
      type: value.type,
      label: value.title,
      extensionName: nameOf.get(extensionId) ?? extensionId,
    })
  }
  return { manifests, nodes, apps, handles }
}

function nodeLabel(node: GraphNodeRecord): string {
  const name = node.data?.name
  return typeof name === 'string' && name.trim() ? name : node.id
}

function graphLocation(ref: GraphRef): string {
  return `${ref.space.name} / ${ref.graph.name}`
}

function graphHref(ref: GraphRef): string {
  return `/space/${ref.space.slug}/app/${ref.graph.slug}`
}

function graphNodes(ref: GraphRef): GraphNodeRecord[] {
  return ref.graph.graph.nodes as unknown as GraphNodeRecord[]
}

/** The handles a manifest declares, each with who declares it — a node type or an App. */
function declaredHandles(manifest: ExtensionManifest): Array<{ owner: string; handle: ExtensionHandle }> {
  const declared: Array<{ owner: string; handle: ExtensionHandle }> = []
  for (const node of manifest.nodes ?? []) {
    for (const handle of node.handles ?? []) {
      declared.push({ owner: node.name, handle })
    }
  }
  for (const app of (manifest.provides?.apps ?? []) as Array<{
    title?: string
    type: string
    handles?: ExtensionHandle[]
  }>) {
    for (const handle of app.handles ?? []) {
      declared.push({ owner: app.title ?? app.type, handle })
    }
  }
  return declared
}

// A registry that fails to fetch is left out of fetchAllRegistries' result
// rather than reported, so the ones missing from it are the unreachable ones.
async function readRegistries(): Promise<RegistryListing> {
  const [sources, fetched] = await Promise.all([getRegistrySources(), fetchAllRegistries()])
  return {
    extensions: fetched.flatMap((reg) =>
      reg.manifest.extensions.map((extension) => ({ id: extension.id, registryName: reg.source.name })),
    ),
    unreachable: sources
      .filter((source) => !fetched.some((reg) => reg.source.url === source.url))
      .map((source) => source.name),
  }
}

/**
 * Every node, app and handle type in use that no installed extension provides.
 * The registries are read only when some unknown type names an extension.
 */
export async function scanUnknownTypes(
  listRegistries: () => Promise<RegistryListing> = readRegistries,
): Promise<TypeScan> {
  const catalog = await readCatalog()
  const unknown = new Map<string, UnknownType>()
  const note = (kind: TypeKind, type: string, usage: TypeUsage) => {
    const key = `${kind}:${type}`
    const entry = unknown.get(key) ?? { kind, type, usages: [] }
    entry.usages.push(usage)
    unknown.set(key, entry)
  }

  const spaces = await registry()
  for (const ref of spaces.listGraphs()) {
    for (const node of graphNodes(ref)) {
      if (typeof node.type === 'string' && !catalog.nodes.has(node.type)) {
        note('node', node.type, { label: nodeLabel(node), location: graphLocation(ref), href: graphHref(ref) })
      }
    }
  }

  const spaceById = new Map(spaces.list().map((space) => [space.id, space]))
  for (const row of await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })) {
    if (catalog.apps.has(row.type)) {
      continue
    }
    const space = spaceById.get(row.spaceId)
    note('app', row.type, {
      label: row.name,
      location: space?.name ?? '',
      ...(space ? { href: `/space/${space.slug}/app/${row.slug}` } : {}),
    })
  }

  for (const manifest of catalog.manifests) {
    for (const { owner, handle } of declaredHandles(manifest)) {
      if (!catalog.handles.has(handle.handleType)) {
        note('handle', handle.handleType, { label: `${owner}: ${handle.label ?? handle.id}`, location: manifest.name })
      }
    }
  }

  const scan: TypeScan = {
    unknown: [...unknown.values()],
    replacements: [...catalog.nodes.values(), ...catalog.apps.values()].map(({ kind, type, label, extensionName }) => ({
      kind,
      type,
      label,
      extensionName,
    })),
  }
  await offerInstalls(scan, new Set(catalog.manifests.map((manifest) => manifest.id)), listRegistries)
  return scan
}

/**
 * Attach an install offer to every unknown type whose extension a registry
 * lists and this instance does not have. An installed extension that does not
 * provide a type is not fixed by installing it again.
 */
async function offerInstalls(
  scan: TypeScan,
  installed: Set<string>,
  listRegistries: () => Promise<RegistryListing>,
): Promise<void> {
  const named = scan.unknown.filter((entry) => {
    const extensionId = extensionIdOfType(entry.type)
    return extensionId !== null && !installed.has(extensionId)
  })
  if (named.length === 0) {
    return
  }
  const listing = await listRegistries()
  scan.unreachableRegistries = listing.unreachable
  for (const entry of named) {
    const extensionId = extensionIdOfType(entry.type)
    const match = listing.extensions.find((candidate) => candidate.id === extensionId)
    if (extensionId && match) {
      entry.install = { extensionId, registryName: match.registryName }
    }
  }
}

/**
 * Refuses anything the page does not offer: only an unknown type is replaced,
 * and only with a known type of the same kind.
 */
function checkRequest(catalog: Catalog, { kind, from, to }: ReplaceRequest): void {
  const known = kind === 'node' ? catalog.nodes : catalog.apps
  if (known.has(from)) {
    throw new Error(`"${from}" is provided by an installed extension; only an unknown ${kind} type can be replaced`)
  }
  if (!known.has(to)) {
    throw new Error(`No installed extension provides the ${kind} type "${to}"`)
  }
}

async function appRowsOfType(type: string) {
  return db.query.spaceApp.findMany({ where: eq(spaceApp.type, type), orderBy: asc(spaceApp.createdAt) })
}

/** Edges of `from` nodes whose handle `to` does not declare, per the edge's side. */
function staleEdgesOf(ref: GraphRef, from: string, toHandles: ExtensionHandle[]): StaleEdge[] {
  const retyped = new Map(
    graphNodes(ref)
      .filter((node) => node.type === from)
      .map((node) => [node.id, node]),
  )
  const stale: StaleEdge[] = []
  for (const edge of ref.graph.graph.edges as unknown as GraphEdgeRecord[]) {
    const source = retyped.get(edge.source)
    if (source && edge.sourceHandle && !findExtensionHandle(toHandles, edge.sourceHandle, 'source')) {
      stale.push({ location: graphLocation(ref), node: nodeLabel(source), handle: edge.sourceHandle })
    }
    const target = retyped.get(edge.target)
    if (target && edge.targetHandle && !findExtensionHandle(toHandles, edge.targetHandle, 'target')) {
      stale.push({ location: graphLocation(ref), node: nodeLabel(target), handle: edge.targetHandle })
    }
  }
  return stale
}

/** What a replace would change, for the confirmation: how many uses, and which edges end up stale. */
export async function planTypeReplacement(request: ReplaceRequest): Promise<ReplacePlan> {
  const catalog = await readCatalog()
  checkRequest(catalog, request)
  if (request.kind === 'app') {
    return { count: (await appRowsOfType(request.from)).length, staleEdges: [] }
  }
  const toHandles = catalog.nodes.get(request.to)?.handles ?? []
  let count = 0
  const staleEdges: StaleEdge[] = []
  for (const ref of (await registry()).listGraphs()) {
    count += graphNodes(ref).filter((node) => node.type === request.from).length
    staleEdges.push(...staleEdgesOf(ref, request.from, toHandles))
  }
  return { count, staleEdges }
}

/**
 * Rewrite every use of an unknown type to a known one. Each graph is one
 * write, so a graph is rewritten whole or not at all; a graph or instance that
 * fails is reported and the rest go ahead. Edges are left as they are.
 */
export async function replaceType(request: ReplaceRequest): Promise<ReplaceResult> {
  const catalog = await readCatalog()
  checkRequest(catalog, request)
  return request.kind === 'node' ? replaceNodeType(request.from, request.to) : replaceAppType(request.from, request.to)
}

async function replaceNodeType(from: string, to: string): Promise<ReplaceResult> {
  const spaces = await registry()
  const result: ReplaceResult = { replaced: 0, failures: [] }
  for (const ref of spaces.listGraphs()) {
    if (!graphNodes(ref).some((node) => node.type === from)) {
      continue
    }
    try {
      result.replaced += await mutateLiveGraph(
        spaces.addressOf(ref),
        { kind: 'system', name: 'node type replacement' },
        (graph) => {
          let replaced = 0
          for (const node of graph.nodes) {
            if (node.type === from) {
              node.type = to
              replaced += 1
            }
          }
          return replaced
        },
      )
    } catch (error) {
      result.failures.push({
        location: graphLocation(ref),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

async function replaceAppType(from: string, to: string): Promise<ReplaceResult> {
  const result: ReplaceResult = { replaced: 0, failures: [] }
  for (const row of await appRowsOfType(from)) {
    try {
      const { loadError } = await retypeSpaceAppImpl(row.id, to)
      result.replaced += 1
      if (loadError) {
        result.failures.push({ location: row.name, error: `Replaced, but the app failed to load: ${loadError}` })
      }
    } catch (error) {
      result.failures.push({ location: row.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
