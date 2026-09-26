// Path resolution for the node-property tools, strict on purpose.
//
// The resolver this replaces created whatever a path named: every missing
// intermediate became an empty object, so a typo in any property path wrote a
// junk key next to the real data and the call reported success. A person
// disabling a schedule with "schedules[0].enabled" was told it worked, twice,
// while the schedule kept firing — the write had landed in a literal key named
// "schedules[0]", created for the occasion.
//
// The rules, and each is a refusal that names the path:
//
// - The grammar is dot-split and nothing else. Brackets are ordinary
//   characters in a key name, never an index — node data keys are arbitrary
//   strings, so a bracketed segment can only MATCH an existing key, and a
//   refusal for a missing one teaches the dot spelling ("schedules.0.enabled").
// - Nothing is created implicitly. Every segment before the last must already
//   exist and be a container. A genuinely new nested structure is written
//   explicitly: first the containing object, then into it.
// - The last segment may introduce a NEW key only on a plain-object parent —
//   that is what writing a property means, and it is the residual typo risk
//   this module cannot remove without removing the tool's purpose. On an
//   array parent it must be an existing index: appending or punching holes in
//   an array is not a property write.
//
// Pure and dependency-free so the rules are testable without the tool host —
// the module these tools live in imports half the server.

/** A path that could not be resolved, with the reason to surface to the caller. */
type Refusal = { ok: false; reason: string }

/** Where a path landed: the container to mutate and the key within it. */
export type PathTarget = { ok: true; parent: Record<string, unknown> | unknown[]; key: string | number } | Refusal

/** Canonical array index: no signs, no leading zeros, so "01" is a key, not index 1. */
const INDEX_RE = /^(0|[1-9][0-9]*)$/

/**
 * Names that address the OBJECT MODEL rather than data. `"__proto__" in obj`
 * is true of every plain object and yields an object, so it walks like a
 * container — and a write through it lands on the global prototype of the
 * running server, while a final-segment write sets the data object's own
 * prototype: present in memory, absent from the saved JSON. That is the
 * incident's exact shape one level down — behaviour that differs from what
 * the stored data shows — so these refuse as reserved rather than resolving
 * or reading as merely missing.
 */
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

function refuse(path: string, detail: string): Refusal {
  return { ok: false, reason: `Path "${path}" does not resolve: ${detail}` }
}

// The incident's spelling gets its own teaching line: a segment carrying
// brackets that matched nothing was almost certainly meant as an index.
function bracketHint(segment: string): string {
  return /[[\]]/.test(segment)
    ? ' Brackets are part of a key name here, never an index — write an array index as its own dot segment, for example "schedules.0.enabled".'
    : ''
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  return `a ${typeof value}`
}

interface Walked {
  ok: true
  /** The container the LAST segment addresses. */
  parent: unknown
  last: string
  /** The path up to (not including) the last segment, for messages. */
  prefix: string
}

function walkToParent(data: Record<string, unknown>, path: string): Walked | Refusal {
  const segments = path.split('.')
  if (path === '' || segments.some((s) => s === '')) {
    return refuse(path, 'it is empty or contains an empty segment')
  }
  const reserved = segments.find((s) => RESERVED_SEGMENTS.has(s))
  if (reserved !== undefined) {
    return refuse(
      path,
      `"${reserved}" is a name of the object model itself, not of data, and cannot be read or written here`,
    )
  }
  let cur: unknown = data
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const prefix = segments.slice(0, i).join('.')
    const at = prefix === '' ? "the node's data" : `"${prefix}"`
    if (Array.isArray(cur)) {
      if (!INDEX_RE.test(seg)) {
        return refuse(path, `${at} is an array and "${seg}" is not an index.${bracketHint(seg)}`)
      }
      const index = Number(seg)
      if (index >= cur.length) {
        return refuse(path, `${at} has ${cur.length} element(s), so index ${index} does not exist`)
      }
      cur = cur[index]
      continue
    }
    if (cur === null || typeof cur !== 'object') {
      return refuse(path, `${at} is ${describe(cur)}, which has no properties`)
    }
    const record = cur as Record<string, unknown>
    // Own property only: `in` walks the prototype chain, on which every name
    // like `toString` "exists" for every object — and none of them is data.
    if (!Object.hasOwn(record, seg)) {
      return refuse(
        path,
        `"${seg}" is not a property of ${at}. Nothing is created implicitly — write the containing object first if it is genuinely new.${bracketHint(seg)}`,
      )
    }
    cur = record[seg]
  }
  return { ok: true, parent: cur, last: segments[segments.length - 1], prefix: segments.slice(0, -1).join('.') }
}

/**
 * Resolve a path for writing a value. The last segment may name a NEW key on a
 * plain-object parent; everything before it must already exist.
 */
export function resolveForWrite(data: Record<string, unknown>, path: string): PathTarget {
  const walked = walkToParent(data, path)
  if (!walked.ok) {
    return walked
  }
  const { parent, last, prefix } = walked
  const at = prefix === '' ? "the node's data" : `"${prefix}"`
  if (Array.isArray(parent)) {
    if (!INDEX_RE.test(last)) {
      return refuse(path, `${at} is an array and "${last}" is not an index.${bracketHint(last)}`)
    }
    const index = Number(last)
    if (index >= parent.length) {
      return refuse(
        path,
        `${at} has ${parent.length} element(s), so index ${index} does not exist — this tool does not append`,
      )
    }
    return { ok: true, parent, key: index }
  }
  if (parent === null || typeof parent !== 'object') {
    return refuse(path, `${at} is ${describe(parent)}, which has no properties`)
  }
  return { ok: true, parent: parent as Record<string, unknown>, key: last }
}

/** Resolve a path that must ALREADY exist — reading a property to edit it. */
export function resolveExisting(data: Record<string, unknown>, path: string): PathTarget {
  const target = resolveForWrite(data, path)
  if (!target.ok) {
    return target
  }
  if (!Array.isArray(target.parent) && !Object.hasOwn(target.parent, String(target.key))) {
    const prefix = path.includes('.') ? `"${path.slice(0, path.lastIndexOf('.'))}"` : "the node's data"
    return refuse(path, `"${String(target.key)}" is not a property of ${prefix}.${bracketHint(String(target.key))}`)
  }
  return target
}

/**
 * Resolve a path for REMOVING a property. It must exist, and it must be an
 * object key: deleting an array element would renumber its neighbours, which
 * is a different operation wearing this one's name.
 */
export function resolveForUnset(data: Record<string, unknown>, path: string): PathTarget {
  const target = resolveExisting(data, path)
  if (!target.ok) {
    return target
  }
  if (Array.isArray(target.parent)) {
    return refuse(
      path,
      'it names an array element — removing one would renumber its neighbours, which this tool does not do',
    )
  }
  return target
}
