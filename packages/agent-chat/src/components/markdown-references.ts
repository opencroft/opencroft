import type { Link, Parent, Root, RootContent, Text } from 'mdast'
import type { ReactNode } from 'react'

/**
 * Identifiers in text -- a ticket key, a resource address, a link into the
 * product -- recognised wherever markdown is shown and drawn as something
 * richer than their characters.
 *
 * This file knows nothing about WHAT is recognised. A host installs one
 * source (`installMarkdownReferences`) describing every recogniser it has and
 * how a recognised reference looks; `Markdown`, the markdown editor and any
 * surface that spreads `markdownDirectiveBlocks` into its own renderer all read
 * that one source. Installed rather than passed through React context so that
 * it reaches every render root the host has without a provider above each.
 *
 * With nothing installed, or a source with no recognisers, nothing here
 * touches the text: markdown renders exactly as it did before references
 * existed.
 */

export interface ReferenceRecogniser {
  /** Names the recogniser; handed back on every reference it claims. */
  kind: string
  /**
   * What the pattern is tested against. `text`: runs of prose, never code.
   * `url`: a bare link -- one whose text is its own address -- tested against
   * the whole address; a link with a label of its own is never claimed.
   */
  match: 'text' | 'url'
  /**
   * The identifier's shape. Only the source is used: every text pattern is
   * folded into one expression, so flags are not carried over. Named groups
   * are reserved for that fold and may not appear in it.
   */
  pattern: RegExp | string
}

export interface InlineReference {
  kind: string
  /** The identifier exactly as written. */
  id: string
  /**
   * The match ends the text it was found in, so the text may still be
   * growing into a longer identifier -- a message arriving in chunks.
   */
  trailing: boolean
}

export interface ReferenceDecoration {
  /** Added to the identifier's own text inside the editor. */
  className?: string
  attributes?: Record<string, string>
  /** Drawn just before the identifier. */
  icon?: ReactNode
}

export interface MarkdownReferenceSource {
  recognisers: readonly ReferenceRecogniser[]
  /** What a reference renders as in read-only markdown. */
  render(reference: InlineReference): ReactNode
  /**
   * How a reference looks inside the markdown editor, where the stored text
   * stays exactly what it is and only its styling changes. Read synchronously
   * from what the host already knows; `subscribe` says when that changed.
   */
  decorate?(reference: InlineReference): ReferenceDecoration | null
  /** The editor's settled references, for a host that resolves them. */
  request?(references: InlineReference[]): void
  /** Called whenever `decorate` would now answer differently. */
  subscribe?(listener: () => void): () => void
}

// ── The installed source ─────────────────────────────────────────────────────

let installed: MarkdownReferenceSource | null = null
let listeners: Array<() => void> = []

/** Replace the source every markdown surface reads, or remove it with null. */
export function installMarkdownReferences(source: MarkdownReferenceSource | null): void {
  installed = source
  for (const listener of listeners) {
    listener()
  }
}

export function getMarkdownReferences(): MarkdownReferenceSource | null {
  return installed
}

export function subscribeMarkdownReferences(listener: () => void): () => void {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((candidate) => candidate !== listener)
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

export interface ReferenceMatch extends Omit<InlineReference, 'trailing'> {
  start: number
  end: number
}

interface CompiledRecognisers {
  /** Every text recogniser as one alternation, group `r<i>` for `text[i]`. */
  text: RegExp | null
  textKinds: string[]
  url: Array<{ kind: string; pattern: RegExp }>
}

const patternSource = (pattern: RegExp | string) => (typeof pattern === 'string' ? pattern : pattern.source)

// Compiled once per recogniser list: a host hands over a new list when a
// pattern changes, and every text node in between reuses this.
let compiledFor: readonly ReferenceRecogniser[] | null = null
let compiled: CompiledRecognisers = { text: null, textKinds: [], url: [] }

function compile(recognisers: readonly ReferenceRecogniser[]): CompiledRecognisers {
  if (recognisers === compiledFor) {
    return compiled
  }
  const text = recognisers.filter((recogniser) => recogniser.match === 'text')
  compiled = {
    text: text.length ? new RegExp(text.map((r, i) => `(?<r${i}>${patternSource(r.pattern)})`).join('|'), 'g') : null,
    textKinds: text.map((recogniser) => recogniser.kind),
    url: recognisers
      .filter((recogniser) => recogniser.match === 'url')
      .map((recogniser) => ({
        kind: recogniser.kind,
        pattern: new RegExp(`^(?:${patternSource(recogniser.pattern)})$`),
      })),
  }
  compiledFor = recognisers
  scanned = emptyMemo()
  scannedKeys = []
  return compiled
}

// The last few hundred texts scanned, by content. A conversation re-renders
// messages whose text has not changed, and a streaming one re-renders the
// same earlier paragraphs on every chunk; neither should pay for the scan
// again. A plain object rather than a Map, for the design kit's preview
// sandbox, which puts every icon in scope by its bare name -- and one with no
// prototype, because the keys are whatever text was written: a paragraph that
// reads `constructor` must not find `Object.prototype`'s.
const SCAN_MEMO = 500
const emptyMemo = (): Record<string, ReferenceMatch[] | undefined> => Object.create(null)
let scanned = emptyMemo()
let scannedKeys: string[] = []

/** Every reference in a run of prose, in order and never overlapping. */
export function findReferences(text: string, recognisers: readonly ReferenceRecogniser[]): ReferenceMatch[] {
  const { text: pattern, textKinds } = compile(recognisers)
  if (!pattern) {
    return []
  }
  const memo = scanned[text]
  if (memo) {
    return memo
  }
  const found: ReferenceMatch[] = []
  for (const match of text.matchAll(pattern)) {
    const groups = match.groups ?? {}
    const index = textKinds.findIndex((_kind, i) => groups[`r${i}`] !== undefined)
    // An empty match claims nothing and would never advance.
    if (index >= 0 && match[0].length > 0) {
      found.push({ kind: textKinds[index], id: match[0], start: match.index, end: match.index + match[0].length })
    }
  }
  if (scannedKeys.length >= SCAN_MEMO) {
    delete scanned[scannedKeys.shift() as string]
  }
  scanned[text] = found
  scannedKeys.push(text)
  return found
}

/** The recogniser claiming a bare link's address, if one does. */
export function matchUrlReference(url: string, recognisers: readonly ReferenceRecogniser[]): string | null {
  return compile(recognisers).url.find((candidate) => candidate.pattern.test(url))?.kind ?? null
}

/** Whether a link is bare: its only content is its own address, as an autolink writes it. */
export function isBareLink(link: Link): boolean {
  const only = link.children.length === 1 ? link.children[0] : undefined
  if (only?.type !== 'text') {
    return false
  }
  // GFM writes `www.example.com` as a link to `http://www.example.com`, and an
  // email address as a `mailto:` link, with the text as typed.
  return only.value === link.url || link.url.endsWith(`//${only.value}`) || link.url === `mailto:${only.value}`
}

// ── The markdown plugin ──────────────────────────────────────────────────────

/** The element a reference is handed to the renderer as. */
export const REFERENCE_ELEMENT = 'inline-reference'

interface ReferenceNode {
  type: 'inlineReference'
  children: Text[]
  data: { hName: string; hProperties: Record<string, string> }
}

function referenceNode(reference: InlineReference, text: string): ReferenceNode {
  return {
    type: 'inlineReference',
    children: [{ type: 'text', value: text }],
    data: {
      hName: REFERENCE_ELEMENT,
      hProperties: { kind: reference.kind, id: reference.id, text, ...(reference.trailing ? { trailing: 'true' } : {}) },
    },
  }
}

// Constructs whose text is never an identifier: code is quoted characters, and
// raw HTML and a link's own label are the author's, not prose to reinterpret.
const OPAQUE = ['code', 'inlineCode', 'html', 'definition', 'image', 'imageReference']

/**
 * Reads the installed source's recognisers and turns every identifier they
 * claim into a `REFERENCE_ELEMENT`, in one walk over the tree. Without a
 * source, or with no recognisers, the tree is left exactly as it was.
 */
export function remarkInlineReferences() {
  return (tree: Root, file: { value?: unknown }) => {
    const recognisers = installed?.recognisers ?? []
    if (recognisers.length === 0) {
      return
    }
    // What counts as the end of the source: a match that reaches it may be an
    // identifier still arriving.
    const end = String(file.value ?? '').trimEnd().length
    walkReferences(tree, recognisers, end)
  }
}

// Named apart from the directive plugin's walk: the design kit evaluates a
// component's files in one scope.
function walkReferences(parent: Parent, recognisers: readonly ReferenceRecogniser[], end: number): void {
  const next: RootContent[] = []
  let changed = false
  for (const child of parent.children) {
    if (child.type === 'text') {
      const parts = splitText(child, recognisers, end)
      changed ||= parts !== null
      next.push(...(parts ?? [child]))
    } else if (child.type === 'link') {
      const kind = isBareLink(child) ? matchUrlReference(child.url, recognisers) : null
      if (kind) {
        const text = (child.children[0] as Text).value
        const trailing = (child.position?.end.offset ?? 0) >= end
        next.push(referenceNode({ kind, id: child.url, trailing }, text) as unknown as RootContent)
        changed = true
      } else {
        next.push(child)
      }
    } else {
      if ('children' in child && !OPAQUE.includes(child.type)) {
        walkReferences(child, recognisers, end)
      }
      next.push(child)
    }
  }
  if (changed) {
    parent.children = next
  }
}

function splitText(node: Text, recognisers: readonly ReferenceRecogniser[], end: number): RootContent[] | null {
  const matches = findReferences(node.value, recognisers)
  if (matches.length === 0) {
    return null
  }
  const endsSource = (node.position?.end.offset ?? 0) >= end
  const parts: RootContent[] = []
  let at = 0
  for (const match of matches) {
    if (match.start > at) {
      parts.push({ type: 'text', value: node.value.slice(at, match.start) })
    }
    const trailing = endsSource && match.end === node.value.length
    parts.push(referenceNode({ kind: match.kind, id: match.id, trailing }, match.id) as unknown as RootContent)
    at = match.end
  }
  if (at < node.value.length) {
    parts.push({ type: 'text', value: node.value.slice(at) })
  }
  return parts
}
