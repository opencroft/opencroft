import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { type DiffLine, diffStats, foldUnchanged, sequenceDiff } from '../tool-views/diff-view'

// Unchanged blocks kept around each change before the rest of an unchanged run
// is folded away.
const CONTEXT_BLOCKS = 1

// The parser behind the split into blocks: the markdown dialect the host's
// renderer and editor share, GFM and directive blocks (`:::note` … `:::`), so
// a callout or a table is one block here as it is one thing on the page.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective)

type Block = ReturnType<typeof parser.parse>['children'][number]
type Code = Extract<Block, { type: 'code' }>
type List = Extract<Block, { type: 'list' }>
type ListItem = List['children'][number]
type Paragraph = Extract<Block, { type: 'paragraph' }>
type Inline = Paragraph['children'][number]
type MarkdownNode = Block | ListItem | Inline

export interface MarkdownBlocks {
  /** The document the blocks were read from. */
  markdown: string
  /** Each top-level block's source, in reading order. */
  blocks: string[]
  /**
   * What each block draws, as a string that is equal for two blocks exactly
   * when they draw the same: the blocks are compared by these, not by their
   * source.
   */
  keys: string[]
  /** Each block's syntax tree, for a changed block to be compared part by part. */
  nodes: Block[]
  /**
   * The link reference definitions (`[label]: url`). They draw nothing, so they
   * are not blocks, but a `[text][label]` link in any block resolves against
   * them, and each block is drawn with them.
   */
  definitions: string
}

// Prose text, where any run of whitespace -- a line break included -- draws as
// one space. Code and raw HTML keep theirs: there it is drawn as written.
const FLOWING_TEXT = new Set(['text', 'inlineCode'])

/*
 * A syntax tree without its positions, its flowing text's whitespace
 * collapsed. Two spellings of one block share it: a paragraph wrapped at a
 * different width, `\_` for `_`, a table's cells padded or its delimiter row
 * written `|---|` or `| --- |`. An editor that saves a page rewrites its source
 * in exactly these ways, so comparing the source would mark every block it
 * touched as changed while it draws as before.
 */
function blockKey(node: unknown): string {
  return JSON.stringify(node, function (this: { type?: unknown }, name, value) {
    if (name === 'position') {
      return undefined
    }
    if (name === 'value' && typeof value === 'string' && FLOWING_TEXT.has(String(this.type))) {
      return value.replace(/\s+/g, ' ')
    }
    return value
  })
}

/** A document as its top-level blocks, each the markdown it was written with. */
export function markdownBlocks(markdown: string): MarkdownBlocks {
  const blocks: string[] = []
  const keys: string[] = []
  const nodes: Block[] = []
  const definitions: string[] = []
  for (const node of parser.parse(markdown).children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) {
      continue
    }
    if (node.type === 'definition') {
      definitions.push(markdown.slice(start, end))
    } else {
      blocks.push(markdown.slice(start, end))
      keys.push(blockKey(node))
      nodes.push(node)
    }
  }
  return { markdown, blocks, keys, nodes, definitions: definitions.join('\n') }
}

/**
 * One entry of a markdown diff as it is drawn. Within each run of changed
 * blocks the removed ones are paired in order with the added ones, the n-th
 * with the n-th, and a pair is drawn removed-then-added with what differs
 * marked; a block left over is drawn alone.
 *
 * A pair is narrowed to what changed where its two versions are the same kind
 * of block: two code blocks are one line diff of their code, with each
 * version's fence info string, its language and meta (`code`), and two lists, or two
 * paragraphs with line breaks, are diffed item by item or line by line
 * (`parts`, `of` items or lines), each part a block's worth of markdown drawn
 * on its own. A list item whose own text is unchanged and whose nested list
 * changed is drawn once, with that list's parts under it (`nested`). Only
 * top-level blocks are narrowed: a list inside a quote or a callout changes as
 * a whole.
 */
export type MarkdownDiffItem =
  | { kind: 'same'; block: string }
  | { kind: 'fold'; blocks: string[] }
  | { kind: 'removed' | 'added'; block: string }
  | { kind: 'pair'; removed: string; added: string }
  | { kind: 'code'; removed: string; added: string; fence: { removed: string; added: string } }
  | { kind: 'parts'; of: 'items' | 'lines'; parts: MarkdownDiffItem[] }
  | { kind: 'nested'; head: string; parts: MarkdownDiffItem[] }

/** A block's markdown with the link definitions it is drawn with. */
export const withDefinitions = (block: string, definitions: string) =>
  definitions ? `${block}\n\n${definitions}` : block

/*
 * The markdown from the start of `first` to the end of `last`, moved to the
 * left margin: each later line loses the indentation the first one had, so a
 * nested list item reads as a list item of its own. Null for a node the parser
 * gave no position.
 */
function sourceOf(markdown: string, first: MarkdownNode, last: MarkdownNode = first): string | null {
  const start = first.position?.start
  const end = last.position?.end.offset
  if (start?.offset === undefined || end === undefined) {
    return null
  }
  const margin = new RegExp(`^ {0,${start.column - 1}}`)
  const [head, ...rest] = markdown.slice(start.offset, end).split('\n')
  return [head, ...rest.map((line) => line.replace(margin, ''))].join('\n')
}

// What a part's markdown draws when it is drawn alone, with its version's link
// definitions, as each part is.
const drawnAlone = (source: string, version: MarkdownBlocks): Block[] =>
  parser.parse(withDefinitions(source, version.definitions)).children.filter((node) => node.type !== 'definition')

/*
 * One version's parts of a changed block, and the markdown a run of them is
 * drawn with on its own: null when that would not draw as the run does in its
 * block.
 */
interface Parts<Part> {
  parts: readonly Part[]
  drawn: (run: readonly Part[]) => string | null
}

/*
 * The diff of two versions' parts, compared by `key`: runs of unchanged parts,
 * and within each run of changed ones the removed paired in order with the
 * added. Null when any part would not draw on its own as it does in its block,
 * for the block to be shown as a pair. `narrow` is tried on a pair before it is
 * drawn as two parts.
 */
function partsDiff<Part>(
  earlier: Parts<Part>,
  later: Parts<Part>,
  key: (part: Part) => string,
  narrow?: (removed: Part, added: Part) => MarkdownDiffItem | null,
): MarkdownDiffItem[] | null {
  const items: MarkdownDiffItem[] = []
  let same: Part[] = []
  let removed: Part[] = []
  let added: Part[] = []
  const endSame = () => {
    if (same.length === 0) {
      return true
    }
    const block = later.drawn(same)
    same = []
    if (block === null) {
      return false
    }
    items.push({ kind: 'same', block })
    return true
  }
  const endChanges = () => {
    const pairs = Math.min(removed.length, added.length)
    for (let n = 0; n < pairs; n++) {
      const narrowed = narrow?.(removed[n], added[n])
      if (narrowed) {
        items.push(narrowed)
        continue
      }
      const earlierBlock = earlier.drawn([removed[n]])
      const laterBlock = later.drawn([added[n]])
      if (earlierBlock === null || laterBlock === null) {
        return false
      }
      items.push({ kind: 'pair', removed: earlierBlock, added: laterBlock })
    }
    // Left over after the pairs, in the order the whole diff draws them: the
    // removed parts, then the added.
    const leftOver = [
      ['removed', removed.slice(pairs), earlier],
      ['added', added.slice(pairs), later],
    ] as const
    for (const [kind, parts, version] of leftOver) {
      for (const part of parts) {
        const block = version.drawn([part])
        if (block === null) {
          return false
        }
        items.push({ kind, block })
      }
    }
    removed = []
    added = []
    return true
  }
  let i = 0
  let j = 0
  for (const { kind } of sequenceDiff(earlier.parts.map(key), later.parts.map(key))) {
    if (kind === 'same') {
      if (!endChanges()) {
        return null
      }
      i++
      same.push(later.parts[j++])
      continue
    }
    if (!endSame()) {
      return null
    }
    if (kind === 'removed') {
      removed.push(earlier.parts[i++])
    } else {
      added.push(later.parts[j++])
    }
  }
  if (!endSame() || !endChanges()) {
    return null
  }
  // Two versions that differ in nothing but how the block holds its parts --
  // a list's numbering or its spacing -- have nothing to narrow to.
  return items.some((item) => item.kind !== 'same') ? items : null
}

const itemKey = (item: ListItem) => blockKey({ checked: item.checked, children: item.children })

/*
 * A loose list draws each item's text as a paragraph, with a paragraph's
 * spacing; a tight one draws it bare. A list is loose when it is spread -- a
 * blank line between two items -- or any item is, by the rule the markdown's
 * HTML is built with.
 */
const isLoose = (list: List) =>
  Boolean(list.spread) || list.children.some((item) => item.spread ?? item.children.length > 1)

// A link label `markdown` does not use, for a definition that resolves nothing of it.
function unusedLabel(markdown: string): string {
  const text = markdown.toLowerCase()
  let label = 'loose-list-item'
  for (let n = 2; text.includes(label); n++) {
    label = `loose-list-item-${n}`
  }
  return label
}

/*
 * The column an item's content starts at: past its marker and the one to four
 * spaces after it, or one space where there are more or none. A task item's
 * text starts later, after its checkbox, but its content does not.
 */
function contentColumn(markdown: string, item: ListItem): number | undefined {
  const start = item.position?.start
  const marker = start?.offset === undefined ? null : /^(?:[-*+]|\d{1,9}[.)])( *)/.exec(markdown.slice(start.offset))
  if (!start || !marker) {
    return undefined
  }
  const spaces = marker[1].length
  return start.column + marker[0].length - spaces + (spaces >= 1 && spaces <= 4 ? spaces : 1)
}

/*
 * `source`, the markdown of the run `items` of `list`, as it draws them on its
 * own as `list` does: null where it does not.
 *
 * A run of a loose list's items without a blank line in it -- a single item
 * always -- would draw tight on its own. It is drawn with a link definition
 * that resolves nothing written after a blank line in its last item: a
 * definition draws nothing, and the blank line makes the item, and so its
 * list, loose.
 */
function itemsSource(source: string, items: readonly ListItem[], list: List, version: MarkdownBlocks): string | null {
  const loose = isLoose(list)
  const first = items[0]
  const content = contentColumn(version.markdown, items[items.length - 1])
  const margin = first.position?.start.column
  const label = loose ? unusedLabel(version.markdown) : undefined
  const written =
    label !== undefined && content !== undefined && margin !== undefined
      ? `${source}\n\n${' '.repeat(content - margin)}[${label}]: #`
      : source
  const [drawn, ...rest] = drawnAlone(written, version)
  if (rest.length > 0 || drawn?.type !== 'list' || isLoose(drawn) !== loose) {
    return null
  }
  const drawnItems = drawn.children.map((item) => ({
    ...item,
    children: item.children.filter((child) => child.type !== 'definition' || child.label !== label),
  }))
  return blockKey(drawnItems.map(itemKey)) === blockKey(items.map(itemKey)) ? written : null
}

/*
 * A list's items as parts, a run of them drawn as a list of its own: from the
 * first one's marker to the end of the last, which numbers an ordered list from
 * the first item's own number.
 */
const listItems = (list: List, version: MarkdownBlocks): Parts<ListItem> => ({
  parts: list.children,
  drawn: (run) => {
    const source = sourceOf(version.markdown, run[0], run[run.length - 1])
    return source === null ? null : itemsSource(source, run, list, version)
  },
})

function listParts(before: MarkdownBlocks, earlier: List, after: MarkdownBlocks, later: List): MarkdownDiffItem[] | null {
  if (earlier.ordered !== later.ordered) {
    return null
  }
  return partsDiff(listItems(earlier, before), listItems(later, after), itemKey, (removed, added) =>
    nestedChange(before, removed, after, added, later),
  )
}

/*
 * Two versions of an item of `list` that differ only in the list the item ends
 * with: the item's own text drawn once, unchanged, and that list's changes
 * under it.
 */
function nestedChange(
  before: MarkdownBlocks,
  removed: ListItem,
  after: MarkdownBlocks,
  added: ListItem,
  list: List,
): MarkdownDiffItem | null {
  const earlierList = removed.children[removed.children.length - 1]
  const laterList = added.children[added.children.length - 1]
  const head = added.children.slice(0, -1)
  if (
    earlierList?.type !== 'list' ||
    laterList?.type !== 'list' ||
    head.length === 0 ||
    removed.checked !== added.checked ||
    blockKey(removed.children.slice(0, -1)) !== blockKey(head)
  ) {
    return null
  }
  const source = sourceOf(after.markdown, added, head[head.length - 1])
  const drawnHead = source === null ? null : itemsSource(source, [{ ...added, children: head }], list, after)
  if (drawnHead === null) {
    return null
  }
  const parts = listParts(before, earlierList, after, laterList)
  return parts ? { kind: 'nested', head: drawnHead, parts } : null
}

// A paragraph's lines: its inline content split at its hard breaks.
function linesOf(paragraph: Paragraph): Inline[][] {
  const lines: Inline[][] = [[]]
  for (const node of paragraph.children) {
    if (node.type === 'break') {
      lines.push([])
    } else {
      lines[lines.length - 1].push(node)
    }
  }
  return lines
}

const hasBreak = (paragraph: Paragraph) => paragraph.children.some((node) => node.type === 'break')

/*
 * A paragraph's lines as parts, a run of them drawn as a paragraph of its own.
 * A line starting `- ` or `# ` draws as a list or a heading on its own, and so
 * cannot be drawn as it is in its paragraph.
 */
const paragraphLines = (paragraph: Paragraph, version: MarkdownBlocks): Parts<Inline[]> => ({
  parts: linesOf(paragraph),
  drawn: (run) => {
    const first = run[0][0]
    const lastLine = run[run.length - 1]
    const last = lastLine[lastLine.length - 1]
    const source = first && last ? sourceOf(version.markdown, first, last) : null
    if (source === null) {
      return null
    }
    const [drawn, ...rest] = drawnAlone(source, version)
    const lines = run.flatMap((line, n) => (n === 0 ? line : [{ type: 'break' }, ...line]))
    const drawsTheRun = rest.length === 0 && drawn?.type === 'paragraph' && blockKey(drawn.children) === blockKey(lines)
    return drawsTheRun ? source : null
  },
})

// Fence languages the page draws as a picture rather than as their code.
const PICTURE_LANGUAGES = new Set(['mermaid'])

// A fence's info string: its language, then its meta.
const fenceInfo = (code: Code) => [code.lang, code.meta].filter(Boolean).join(' ')

/*
 * Two versions of a code block as the line diff of their code, with each
 * version's fence info string -- the language its lines are coloured in and
 * labelled with, or the label's change when the two differ. A picture on
 * either side is shown as the page shows it, so the two stay a pair.
 */
function codeChange(removed: Code, added: Code): MarkdownDiffItem | null {
  if (PICTURE_LANGUAGES.has(removed.lang ?? '') || PICTURE_LANGUAGES.has(added.lang ?? '')) {
    return null
  }
  return {
    kind: 'code',
    removed: removed.value,
    added: added.value,
    fence: { removed: fenceInfo(removed), added: fenceInfo(added) },
  }
}

/*
 * A changed block narrowed to what changed in it, where its two versions are
 * the same kind of block; a pair of the two otherwise.
 */
function changedBlock(before: MarkdownBlocks, earlier: number, after: MarkdownBlocks, later: number): MarkdownDiffItem {
  const removed = before.nodes[earlier]
  const added = after.nodes[later]
  let narrowed: MarkdownDiffItem | null = null
  if (removed.type === 'code' && added.type === 'code') {
    narrowed = codeChange(removed, added)
  } else if (removed.type === 'list' && added.type === 'list') {
    const parts = listParts(before, removed, after, added)
    narrowed = parts && { kind: 'parts', of: 'items', parts }
  } else if (removed.type === 'paragraph' && added.type === 'paragraph' && (hasBreak(removed) || hasBreak(added))) {
    const parts = partsDiff(paragraphLines(removed, before), paragraphLines(added, after), blockKey)
    narrowed = parts && { kind: 'parts', of: 'lines', parts }
  }
  return narrowed ?? { kind: 'pair', removed: before.blocks[earlier], added: after.blocks[later] }
}

// A block diff entry with the block's index in its version: a removed block's
// in `before`, an added or unchanged one's in `after`, which is the version an
// unchanged block is drawn in.
interface BlockEntry extends DiffLine {
  index: number
}

function blockDiff(before: MarkdownBlocks, after: MarkdownBlocks): BlockEntry[] {
  let earlier = 0
  let later = 0
  return sequenceDiff(before.keys, after.keys).map(({ kind }) => {
    if (kind === 'removed') {
      const index = earlier++
      return { kind, text: before.blocks[index], index }
    }
    if (kind === 'same') {
      earlier++
    }
    const index = later++
    return { kind, text: after.blocks[index], index }
  })
}

/** The diff from `before` to `after`, block by block, unchanged runs folded past `context` blocks. */
export function markdownDiff(before: MarkdownBlocks, after: MarkdownBlocks, context = CONTEXT_BLOCKS): MarkdownDiffItem[] {
  const items: MarkdownDiffItem[] = []
  let removed: BlockEntry[] = []
  let added: BlockEntry[] = []
  const endRun = () => {
    const pairs = Math.min(removed.length, added.length)
    for (let i = 0; i < pairs; i++) {
      items.push(changedBlock(before, removed[i].index, after, added[i].index))
    }
    items.push(...removed.slice(pairs).map((entry) => ({ kind: 'removed' as const, block: entry.text })))
    items.push(...added.slice(pairs).map((entry) => ({ kind: 'added' as const, block: entry.text })))
    removed = []
    added = []
  }
  const diff = blockDiff(before, after)
  const { added: addedCount, removed: removedCount } = diffStats(diff)
  if (addedCount === 0 && removedCount === 0) {
    return []
  }
  for (const row of foldUnchanged(diff, context)) {
    if (row.kind === 'fold') {
      endRun()
      items.push({ kind: 'fold', blocks: row.lines.map((entry) => entry.text) })
    } else if (row.line.kind === 'same') {
      endRun()
      items.push({ kind: 'same', block: row.line.text })
    } else {
      ;(row.line.kind === 'removed' ? removed : added).push(row.line)
    }
  }
  endRun()
  return items
}
