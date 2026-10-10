/**
 * `@opencroft/client/markdown` — markdown as the host renders, edits and
 * compares it, mermaid diagrams, and the resolvers that turn identifiers in
 * markdown into reference chips.
 */
import type { ComponentType, FC, ReactNode } from 'react'

export interface MarkdownProps {
  /** The markdown source. */
  text: string
  /**
   * Added to the prose wrapper, for the width constraints and clamps your
   * surface needs — not for restyling the prose, which is shared on purpose so
   * that everything rendered this way reads as one voice.
   */
  className?: string
}

/**
 * Markdown, rendered the way the chat renders it: GFM, fenced blocks as
 * `CodeBlock`, and a `mermaid` fence as the diagram it describes.
 *
 * The host owns it for the highlighter reason `CodeBlock` gives, and for one
 * the types cannot show: links are given `rel="noopener noreferrer"` with
 * their `target="_blank"`. That is a security property, and a second copy of
 * the renderer drops it with nothing to see — the links still open. Reaching
 * for this one keeps the guarantee instead of asking every surface to
 * remember it.
 */
export declare const Markdown: FC<MarkdownProps>

/**
 * The documentation blocks `Markdown` draws -- callouts (`:::note` …
 * `:::caution`), `:::details` spoilers and `::::tabs` of `:::tab` -- for a
 * surface that has to keep its own `react-markdown`: add `remarkPlugins` after
 * your own plugins and spread `components` into yours. Any other directive
 * then renders as its plain content, as it does in `Markdown`, and what
 * `MarkdownEditor` writes never shows as raw `:::`.
 *
 * Typed loosely on purpose: the plugins are unified plugins and the
 * components take `react-markdown`'s element props, and naming those types here
 * would tie this package to both libraries' versions.
 */
export declare const markdownDirectiveBlocks: {
  // biome-ignore lint/suspicious/noExplicitAny: unified plugin signatures vary by plugin
  remarkPlugins: ((...args: any[]) => any)[]
  // biome-ignore lint/suspicious/noExplicitAny: react-markdown element props, see above
  components: Record<string, ComponentType<any>>
}

export interface MermaidDiagramProps {
  /** The diagram source, exactly as it was written inside the fenced block. */
  chart: string
  /**
   * Added to the wrapper, for the width constraints and clamps your surface
   * needs — not for the diagram's own colours, which come from the mermaid
   * theme. That theme follows the host's light/dark and is deliberately not
   * stylable from here.
   */
  className?: string
}

/**
 * A mermaid diagram, rendered from its source. Presentational and fully
 * controlled: it fetches nothing and never rewrites the text it was handed.
 * Source that does not parse falls back to showing that source with the parse
 * error beneath it — the same fallback as a diagram that has not drawn yet,
 * because to a reader those are the same situation.
 *
 * The host owns it for two reasons the types cannot show. mermaid is fetched
 * through a dynamic import the first time a diagram appears, because it costs
 * on the order of a megabyte gzipped — an extension bundling its own would pay
 * that again, once per extension. And it is initialised at `securityLevel:
 * 'strict'`, which is what keeps agent-authored source from rendering label
 * text as raw HTML or installing a `click` handler; a second copy configured
 * by hand is one option away from losing that with nothing to see.
 */
export declare const MermaidDiagram: FC<MermaidDiagramProps>

/**
 * A group of toolbar controls. Named rather than listed one by one so a surface
 * can ask for less without enumerating buttons it does not know about yet.
 * `blockMenu` is the Blocks menu: callouts, spoiler, tabs, table and divider.
 */
export type MarkdownEditorToolbarGroup = 'history' | 'marks' | 'headings' | 'blocks' | 'links' | 'table' | 'blockMenu'

/** A document the caller holds as markdown. */
export interface MarkdownEditorOwnDocument {
  /** The markdown being edited. Controlled — the caller holds it. */
  value: string
  /** The markdown after an edit. Fires for edits, never for loading `value`. */
  onChange: (markdown: string) => void
  collab?: never
}

/**
 * A document several people edit at once, stored where the extension keeps it
 * (see `collab.markdown` on the server host). Everyone with it open sees the
 * others' carets and selections and who is there; a change an agent makes
 * through the server host is played back as it lands; undo reverts only this
 * person's own changes.
 */
export interface MarkdownEditorSharedDocument {
  /** `document` is the name the server host's `collab.markdown.documentName` gave. */
  collab: { document: string }
  value?: never
  onChange?: never
}

export type MarkdownEditorProps = MarkdownEditorSurfaceProps &
  (MarkdownEditorOwnDocument | MarkdownEditorSharedDocument)

/** How the editor looks and behaves, whichever document it edits. */
export interface MarkdownEditorSurfaceProps {
  /** Shown while the document is empty. Read once, when the editor is created. */
  placeholder?: string
  /** Editable by default; `false` shows the same prose read-only. */
  editable?: boolean
  /** Put the caret at the end of the document on mount. */
  autoFocus?: boolean
  /** Which toolbar groups to offer, in the order given. All of them by default; `false` for none. */
  toolbar?: false | MarkdownEditorToolbarGroup[]
  /**
   * Rendered at the end of the toolbar row, after a spacer — for a surface
   * whose own actions belong on that row rather than above it.
   */
  toolbarExtra?: ReactNode
  /**
   * Added to the toolbar row — for a surface where the editor grows with its
   * content and the page scrolls rather than the editor, where the toolbar has
   * to be `sticky` to stay reachable. The editor cannot decide that for itself:
   * it depends on which box around it is the scrolling one.
   */
  toolbarClassName?: string
  /** Added to the editor's outer box, for the layout your surface needs. */
  className?: string
  /**
   * Classes for the editable area, REPLACING the default prose styling rather
   * than adding to it: a surface with prose rules of its own would otherwise
   * render under both sets.
   */
  contentClassName?: string
}

/**
 * A markdown WYSIWYG: rich text to edit, markdown to store.
 *
 * Controlled on markdown in both directions, because markdown is what the
 * surfaces editing this way actually persist -- or bound to a shared document
 * through `collab`. HTML in a stored body other than `<br>` is shown as the
 * characters it was written with, the same wherever the markdown is read.
 *
 * The host owns it for three reasons, in order of how much they cost to get
 * wrong. TipTap and ProseMirror are a large dependency, and an extension
 * bundling its own pays for the whole editor again — per extension. Code blocks
 * inside it are coloured by the page's one shiki highlighter, the same instance
 * and grammar cache `CodeBlock` and `Markdown` use, so a block typed here and
 * the same block once rendered are coloured by the same thing. And one editor
 * means one markdown dialect: what this writes is what `Markdown` renders.
 */
export declare const MarkdownEditor: FC<MarkdownEditorProps>

export interface MarkdownDiffViewProps {
  /** The earlier version's markdown. Empty for a document that did not exist. */
  before: string
  /** The later version's markdown. */
  after: string
  /**
   * Draws one block's markdown as your page draws markdown, WITHOUT a prose
   * wrapper of its own: the blocks are set side by side in the view's prose,
   * where their margins meet as they do on your page. It is also handed parts
   * of a block -- a list's items, a paragraph's lines -- each as markdown that
   * stands on its own. Items of a loose list end with a link definition, which
   * draws nothing and keeps them loose.
   */
  renderBlock: (markdown: string) => ReactNode
  /** Unchanged blocks kept around each change before a run folds. Defaults to 1. */
  context?: number
  /** The prose the blocks are set in, replacing the default `prose-chat`. */
  proseClassName?: string
}

/**
 * What changed between two versions of a markdown document, shown on the
 * document as it renders rather than on its source: no `**` or `##` anywhere.
 *
 * Both versions are split into their top-level blocks -- a paragraph, a
 * heading, a list, a table, a callout -- with the host's markdown dialect, and
 * the blocks are compared by what they draw. An added block is framed green, a
 * removed one red; a changed one is shown removed then added, with the words
 * that differ marked in its rendered text. A changed list, or paragraph with
 * line breaks, is narrowed to the items or lines that changed, and a changed
 * code block is a line diff of its code, set and coloured as the host's code
 * blocks are -- removed lines in the earlier fence's language, the rest in the
 * later's -- and labelled as they are, with its language, or `old → new` when
 * its fence changed; a
 * `mermaid` diagram stays its two pictures. Longer unchanged runs fold
 * into a row that opens in place. Two equal versions show "No changes".
 *
 * Every block is drawn by `renderBlock`, so links, code and documentation
 * blocks look exactly as on your page. The marks are painted over the drawn
 * text and never change its DOM, so a renderer that fills in later -- a code
 * block colouring itself -- is followed.
 */
export declare const MarkdownDiffView: FC<MarkdownDiffViewProps>

/** A reference's state, shown as a dot beside its name. */
export type MarkdownReferenceTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted'

/** What a recognised identifier's chip shows. */
export interface MarkdownReference {
  /** The short name -- a key, a node's name. Never truncated. */
  label: string
  /** Text after the label, e.g. a summary, in regular weight. The first thing to truncate. */
  detail?: string
  /**
   * A lucide icon name, drawn at the text's size; or your own mark -- your
   * type glyph -- drawn exactly as given.
   */
  icon?: string | ReactNode
  /**
   * The state as you draw it elsewhere -- your status badge -- shown at the
   * chip's right end, and truncated only once `detail` has nothing left.
   */
  state?: ReactNode
  /** A state dot after the label, for a state with no drawing of its own. */
  tone?: MarkdownReferenceTone
  /** The state in words, read out by assistive technology. */
  stateLabel?: string
  /** Where pressing the chip goes. A same-origin address navigates inside the app. */
  href?: string
  /** What pressing the chip does, for a target that is not a page. */
  open?: () => void
  /**
   * Shown in a popover beside the chip when it is pressed, for a target better
   * described than opened -- a card about the thing, drawn with your own
   * components. It takes the press: `href` and `open` are not used for it.
   * Drawn only in rendered markdown; in `MarkdownEditor` a press places the
   * caret, as it does on a link.
   */
  popover?: ReactNode
}

export interface MarkdownReferenceMenuItem {
  label: string
  /** Lucide icon name. */
  icon?: string
  onSelect: () => void
}

/**
 * Recognises one kind of identifier in markdown and says what it is. Declared
 * under `provides.markdownResolvers` of `defineExtension`; every `Markdown`
 * and `MarkdownEditor` the host renders then uses it, with nothing to wire.
 *
 * Keep the pattern tight: whatever it claims becomes a chip at once, before
 * `resolve` has answered, and one nothing answers to stays a muted chip.
 * Code, inline code and links with a label of their own are never claimed.
 */
export interface MarkdownResolver {
  /** Unique across extensions, e.g. `myext.ticket`. */
  id: string
  /**
   * `text` (default): prose. `url`: a bare link, one whose text is its own
   * address, tested against the whole address.
   */
  match?: 'text' | 'url'
  /**
   * The identifier's shape. Folded into one expression with every other
   * resolver's: flags are dropped and named groups are not allowed. `null`
   * claims nothing (yet).
   */
  pattern: RegExp | string | null
  /** For a pattern that changes: call `set` with each new one; return the unsubscribe. */
  watchPattern?: (set: (pattern: RegExp | string | null) => void) => () => void
  /**
   * What the chip shows from the identifier alone, before `resolve` answers,
   * and still shows when nothing answers to it.
   */
  preview?: (id: string) => Partial<MarkdownReference>
  /**
   * The identifier as written already carries the chip's mark, as the `@` of
   * a mention does. The editor, which shows the identifier as written, then
   * draws no icon before it; rendered markdown, which shows the label, still
   * does.
   */
  markedInText?: boolean
  /**
   * Everything on screen that this resolver claimed and is not already known,
   * batched: one call per tick, each identifier once. Null, or a missing key,
   * means nothing answers to it.
   */
  resolve: (ids: string[]) => Promise<Record<string, MarkdownReference | null>>
  /**
   * Call `invalidate` when what `resolve` answered may have changed -- all of
   * it, or the listed identifiers. Answers are otherwise kept for the session;
   * without this they are asked again after a minute.
   */
  subscribe?: (invalidate: (ids?: string[]) => void) => () => void
  /** The chip's context menu in rendered markdown; none when empty. */
  menu?: (id: string, reference: MarkdownReference | null) => MarkdownReferenceMenuItem[]
}
