/**
 * `@opencroft/client` — the surface an extension's client (node/UI) code imports.
 *
 * Re-exports the shared contracts from `@opencroft/core` at the root, and the
 * full ported `@ext/host` + `@ext/ui` surface under `legacy` for migration. The
 * runtime is injected by the host; these are the type declarations.
 */
import type { AppEntry } from '@opencroft/core'
import type { TerminalProps } from '@opencroft/terminal/client'
import type { ComponentType, FC, ReactNode } from 'react'

export * from '@opencroft/core'
export type { TerminalConfig, TerminalProps, TerminalStatus } from '@opencroft/terminal/client'

export * as legacy from './legacy'

/** Embeddable xterm terminal connected to the host's terminal WebSocket. */
export declare const Terminal: FC<TerminalProps>

export interface SecretSelectorProps {
  /** `<storeId>/<key>` of the selected secret, or '' for none. */
  value?: string
  onChange: (value: string) => void
  /** Offer an explicit "None" choice (reported as ''). */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
}

/**
 * Pick one secret KEY from the host's Secrets Stores. Only the key's address
 * (`<storeId>/<key>`) crosses the component — never the value; resolve it
 * server-side with `host.secrets.get(storeId, key)`.
 */
export declare const SecretSelector: FC<SecretSelectorProps>

export interface TerminalSelectorProps {
  /** "node-id/handle-id" of the selected terminal source, or '' for none. */
  value?: string
  onChange: (value: string) => void
  /** Limit the choices to one space's nodes; omit to offer every space. */
  spaceSlug?: string
  /** Offer an explicit "None" choice (reported as ''). */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
}

/**
 * Pick one terminal-context SOURCE handle from the graph. The value is the
 * "node-id/handle-id" target string every terminal-taking host API accepts
 * (`host.terminal.getContext`, the remote file tools). Terminal Router outputs
 * are not offered: they only re-expose terminals the list already has.
 */
export declare const TerminalSelector: FC<TerminalSelectorProps>

export interface NodeRefProps {
  /** A graph node id, or an App instance's id / `<space>.<app-slug>` address. */
  nodeId: string
  /** Text after the name, e.g. which of the node's handles is meant. */
  detail?: string
  className?: string
}

/**
 * A node (or App instance) shown by its icon and name instead of its id,
 * resolved across every space; the raw id stays on hover.
 */
export declare const NodeRef: FC<NodeRefProps>

export interface TerminalRefProps {
  /** "node-id/handle-id" -- the form the TerminalSelector hands out. */
  target: string
  className?: string
}

/** A terminal target shown as its node's name plus which of its terminals it is. */
export declare const TerminalRef: FC<TerminalRefProps>

export interface CodeBlockProps {
  /** The code to render, exactly as it was written. */
  code: string
  /**
   * The fence's info string or a bare language name (`ts`, `bash`, `json`).
   * Aliases are resolved for you; anything unrecognised renders as plain text.
   */
  language?: string
  /** Offer the copy control, on by default. */
  copyable?: boolean
  /** Added to the block's wrapper, for the layout your surface needs. */
  className?: string
}

/**
 * A static, highlighted code block — the one the chat renders.
 *
 * The host owns it because the highlighter behind it is a shared resource: one
 * instance and one grammar cache serve the whole page, and a grammar is
 * fetched once, the first time something asks for that language. An extension
 * that bundled its own renderer would run a second highlighter and re-download
 * the grammars the chat already holds — again per extension.
 */
export declare const CodeBlock: FC<CodeBlockProps>

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
 * The host owns it for the highlighter reason above, and for one the types
 * cannot show: links are given `rel="noopener noreferrer"` with their
 * `target="_blank"`. That is a security property, and a second copy of the
 * renderer drops it with nothing to see — the links still open. Reaching for
 * this one keeps the guarantee instead of asking every surface to remember it.
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

export interface CodeBlockEditorProps {
  /** The code being edited. Controlled — the caller holds it. */
  value: string
  onChange: (value: string) => void
  /**
   * The fence's info string or a bare language name, resolved exactly the way
   * `CodeBlock` resolves it. An unknown language edits fine, uncoloured.
   */
  language?: string
  /** The shortest the editor gets, in lines, so an empty one is not a slot. Defaults to 6. */
  minLines?: number
  /** Added to the editor's own box, for the layout your surface needs. */
  className?: string
}

/**
 * Code that can be edited in place, coloured by the same highlighter as
 * `CodeBlock`.
 *
 * A transparent textarea layered over highlighted text rather than a mounted
 * editor, and that is the reason to reach for this instead of `CodeEditor`: it
 * costs nothing to appear, so a surface can carry a dozen of them and any one
 * can be typed into the instant it renders. `CodeEditor` buys line numbers,
 * find and an undo stack of its own and pays for them with a Monaco mount —
 * the right trade for one editor on a page and the wrong one for twelve.
 *
 * Shared from the host for `CodeBlock`'s reason too: the highlighter under it
 * is one instance and one grammar cache for the whole page.
 */
export declare const CodeBlockEditor: FC<CodeBlockEditorProps>

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

export interface MarkdownEditorProps {
  /** The markdown being edited. Controlled — the caller holds it. */
  value: string
  /** The markdown after an edit. Fires for edits, never for loading `value`. */
  onChange: (markdown: string) => void
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
 * surfaces editing this way actually persist. Legacy HTML in a stored body is
 * read as the rich text it describes and written back as markdown on the next
 * save, so nothing has to be migrated ahead of the editor.
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

/** Props the host passes to an App's component when rendering it in a space. */
export interface AppComponentProps {
  /** Which added instance is being rendered — matches the server hooks' `instanceId`. */
  instanceId: string
  spaceSlug: string
  /** The parameter values the user entered when adding the App, keyed by parameter id. */
  params: Record<string, string>
}

/**
 * Props the host passes to an App's custom parameter form. The form is
 * CONTROLLED: it renders `params` and reports every change through
 * `onChange`; the host owns the dialog, the submit button, and persistence.
 */
export interface AppFormProps {
  /** The space the instance is being added to (or lives in, when editing). */
  spaceSlug: string
  params: Record<string, string>
  onChange: (params: Record<string, string>) => void
}

/**
 * The client half of an App: the manifest's `provides.apps` entry plus the
 * React component. Declared under the same `apps` point in the client
 * `provides` of `defineExtension`, so the two halves are matched by slug.
 */
export interface AppDefinition extends AppEntry {
  component: ComponentType<AppComponentProps>
  /**
   * Custom parameter form, replacing the host's generic one (which renders a
   * text input per declared manifest parameter). Declared `required`
   * parameters are still validated by the host on save.
   */
  form?: ComponentType<AppFormProps>
}
