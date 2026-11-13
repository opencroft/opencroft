// A graph held as a Yjs doc, and the mapping between it and the plain
// `{ nodes, edges }` JSON every reader of a graph works with.
//
// Shape: `nodes` and `edges` are Y.Maps from id to a Y.Map of that element's
// fields. A node's `data` is one level deeper -- a Y.Map from each top-level
// data key to its value -- so two writers changing different keys of one
// node's data both land. Every other value is stored whole and opaque: what is
// inside an extension's data value is the extension's business, and a
// concurrent write to one key is last-writer-wins.
//
// The plain arrays are ordered, the maps are not, so each element carries its
// position under SEQ. A new element goes after every existing one; two
// elements given the same position concurrently are ordered by id.

import * as Y from 'yjs'

import { parentsFirst } from '@/app/_authed/(extension-runtime)/_frame-tree'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

/**
 * Bumped whenever the doc shape above, or what its nodes mean, changes
 * incompatibly: 2 holds frame members as children (`parentId`, positions
 * relative to the frame; see `_frame-tree.ts`).
 */
export const GRAPH_DOC_SCHEMA_VERSION = 2

// `$` keeps it out of the names React Flow and extensions give their fields.
const SEQ = '$seq'
// The node field stored as a map of its own keys rather than one value.
const NESTED_NODE_FIELD = 'data'

type Element = Record<string, unknown>
type ElementMap = Y.Map<unknown>

export function graphNodes(doc: Y.Doc): Y.Map<ElementMap> {
  return doc.getMap('nodes')
}

export function graphEdges(doc: Y.Doc): Y.Map<ElementMap> {
  return doc.getMap('edges')
}

export interface ApplyGraphOptions {
  /**
   * The graph `next` was derived from. Only what differs between the two is
   * written: a field the writer left as it found it keeps whatever the doc
   * holds now, even if someone changed it since, and an edit to an element
   * deleted since is dropped. Defaults to the doc's current graph, which is
   * right only when `next` was derived from the doc in the same transaction.
   */
  base?: GraphData
  /** The transaction origin, unless the call runs inside the caller's own transaction. */
  origin?: unknown
}

/**
 * Writes the change from `base` to `next` into the doc, in one transaction.
 * Elements without a string id, and repeats of an id, are not written -- such
 * a graph does not round-trip, which `jsonEqual` on the projection reports.
 */
export function applyGraphToDoc(doc: Y.Doc, next: GraphData, { base, origin = null }: ApplyGraphOptions = {}): void {
  doc.transact(() => {
    const from = base ?? readGraphFromDoc(doc)
    applyElements(graphNodes(doc), from.nodes, next.nodes, NESTED_NODE_FIELD)
    applyElements(graphEdges(doc), from.edges, next.edges, null)
  }, origin)
}

/**
 * `target` with the change from `before` to `after` applied, by exactly the
 * rules applyGraphToDoc writes a doc by: the plain-JSON counterpart, for a
 * writer that has to know what the doc will hold after its write.
 */
export function applyGraphChange(target: GraphData, before: GraphData, after: GraphData): GraphData {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, target)
  applyGraphToDoc(doc, after, { base: before })
  return readGraphFromDoc(doc)
}

/**
 * The plain graph the doc holds: elements in their stored order, with every
 * node after its parent, as React Flow requires. Values are copies, so a caller
 * mutating the result cannot change the doc behind its back.
 */
export function readGraphFromDoc(doc: Y.Doc): GraphData {
  return {
    nodes: parentsFirst(readElements(graphNodes(doc))),
    edges: readElements(graphEdges(doc)),
  }
}

/**
 * Whether two graphs hold the same elements with the same fields, whatever
 * order their arrays list them in.
 */
export function sameGraphContent(a: GraphData, b: GraphData): boolean {
  const sameSet = (x: Element[], y: Element[], same: typeof sameNode) => {
    const byIdX = new Map(x.map((e) => [e.id, e]))
    return x.length === y.length && byIdX.size === x.length && y.every((e) => same(byIdX.get(e.id), e))
  }
  return sameSet(a.nodes, b.nodes, sameNode) && sameSet(a.edges, b.edges, sameEdge)
}

/** Ids of the nodes and edges added, removed or changed between two graphs. */
export function changedElementIds(before: GraphData, after: GraphData): { nodeIds: string[]; edgeIds: string[] } {
  const changed = (x: Element[], y: Element[], same: typeof sameNode) => {
    const was = byId(x)
    const now = byId(y)
    const ids = new Set<string>()
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      if (!same(was.get(id), now.get(id))) {
        ids.add(id)
      }
    }
    return [...ids]
  }
  return {
    nodeIds: changed(before.nodes, after.nodes, sameNode),
    edgeIds: changed(before.edges, after.edges, sameEdge),
  }
}

/**
 * Equality of two JSON values as the doc stores a value: whole, with an
 * object's keys in their order, so a value whose keys only moved is a change
 * and is written. Rows a user put in order, such as an environment's
 * variables, are kept as an object in that order. Undefined fields are
 * ignored, as JSON drops them.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]))
  }
  const ak = definedKeys(a as Element)
  const bk = definedKeys(b as Element)
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && jsonEqual((a as Element)[k], (b as Element)[k]))
}

/**
 * Whether two nodes hold the same fields as the doc stores them. A node's
 * fields and its data keys are Y.Map keys, which keep no order, so their order
 * is ignored; each value under them compares by `jsonEqual`.
 */
export function sameNode(a: Element | undefined, b: Element | undefined): boolean {
  return sameFields(a, b, NESTED_NODE_FIELD)
}

/** Whether two edges hold the same fields, as `sameNode` compares nodes. */
export function sameEdge(a: Element | undefined, b: Element | undefined): boolean {
  return sameFields(a, b, null)
}

function sameFields(a: Element | undefined, b: Element | undefined, nestedField: string | null): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  const ak = definedKeys(a)
  return (
    ak.length === definedKeys(b).length &&
    ak.every((k) => {
      const x = a[k]
      const y = b[k]
      return k === nestedField && isPlainObject(x) && isPlainObject(y) ? sameFields(x, y, null) : jsonEqual(x, y)
    })
  )
}

function definedKeys(value: Element): string[] {
  return Object.keys(value).filter((k) => value[k] !== undefined)
}

function applyElements(
  map: Y.Map<ElementMap>,
  baseList: Element[],
  nextList: Element[],
  nestedField: string | null,
): void {
  const base = byId(baseList)
  const next = byId(nextList)
  for (const id of base.keys()) {
    if (!next.has(id)) {
      map.delete(id)
    }
  }
  let nextSeq = maxSeq(map) + 1
  for (const [id, element] of next) {
    const before = base.get(id)
    let entry = map.get(id)
    if (!entry) {
      if (before) {
        // Deleted since the writer read it; an edit does not bring it back.
        continue
      }
      entry = new Y.Map()
      map.set(id, entry)
      entry.set(SEQ, nextSeq++)
    }
    writeChanges(entry, before ?? {}, element, nestedField, ELEMENT_KEYS)
  }
}

function byId(list: Element[]): Map<string, Element> {
  const out = new Map<string, Element>()
  for (const element of list) {
    if (typeof element.id === 'string' && !out.has(element.id)) {
      out.set(element.id, element)
    }
  }
  return out
}

// Keys of an element's own map that are not fields of the plain element.
const ELEMENT_KEYS = new Set(['id', SEQ])
const NO_KEYS = new Set<string>()

// Writes into `target` every key whose value differs between `before` and
// `after`; a key gone from `after` is deleted. With `nestedField`, that key's
// plain-object value is written into a nested Y.Map key by key.
function writeChanges(
  target: Y.Map<unknown>,
  before: Element,
  after: Element,
  nestedField: string | null,
  skip: ReadonlySet<string> = NO_KEYS,
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key)) {
      continue
    }
    const was = before[key]
    const now = after[key]
    if (key === nestedField && isPlainObject(now)) {
      let nested = target.get(key)
      if (!(nested instanceof Y.Map)) {
        nested = new Y.Map()
        target.set(key, nested)
        writeChanges(nested as Y.Map<unknown>, {}, now, null)
      } else {
        writeChanges(nested as Y.Map<unknown>, isPlainObject(was) ? was : {}, now, null)
      }
    } else if (!jsonEqual(was, now)) {
      if (now === undefined) {
        target.delete(key)
      } else {
        target.set(key, now)
      }
    }
  }
}

function readElements(map: Y.Map<ElementMap>): Element[] {
  const rows: { id: string; seq: number; element: Element }[] = []
  for (const [id, entry] of map.entries()) {
    const element: Element = { id }
    for (const [key, value] of entry.entries()) {
      if (!ELEMENT_KEYS.has(key)) {
        element[key] = value instanceof Y.Map ? value.toJSON() : value
      }
    }
    rows.push({ id, seq: seqOf(entry), element: structuredClone(element) })
  }
  rows.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows.map((r) => r.element)
}

function maxSeq(map: Y.Map<ElementMap>): number {
  let max = -1
  for (const entry of map.values()) {
    max = Math.max(max, seqOf(entry))
  }
  return max
}

function seqOf(entry: ElementMap): number {
  const seq = entry.get(SEQ)
  return typeof seq === 'number' ? seq : 0
}

function isPlainObject(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
