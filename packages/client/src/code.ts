/**
 * `@opencroft/client/code` — code shown and edited with the host's one
 * highlighter and its one Monaco runtime.
 */
import type { FC } from 'react'

export interface CodeBlockProps {
  /** The code to render, exactly as it was written. */
  code: string
  /**
   * The fence's info string or a bare language name (`ts`, `bash`, `json`).
   * Its first word labels the block, over the code; without one the block has
   * no label. Aliases are resolved for the colours; anything unrecognised
   * renders as plain text. A `title=` or `filename=` in it (`ts title="app.ts"`)
   * names the file the block downloads as; without one it is `snippet.<ext>`
   * from the language, or `snippet.txt`.
   */
  language?: string
  /**
   * Offer the copy and download controls, on by default. Every block also has
   * a wrap-lines toggle, whatever this says.
   */
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

// Whatever this is, it reaches Monaco verbatim, and Monaco registers around
// forty languages and accepts every one of them at run time. So a closed union
// would not be the set that works, only a ceiling on the set you may ask for,
// and the six below are simply the ones the host's own surfaces use.
//
// `(string & {})` opens it to the other thirty-odd while keeping the six as
// autocomplete. Naming all forty is avoided for two reasons.
// It would put a copy of Monaco's registry in a file that does not own it, so
// every entry is either a lie until the next Monaco upgrade or a truth nobody
// re-checked. And it buys nothing for the callers that need the width, because
// they compute the language at run time from something that is already a
// string: an extension mapping a file path to a language has a `string` in
// hand, so a closed union would meet it with a cast at every call site and
// throw away the only thing a closed union is for.
//
// Kept identical to the host component's own declaration in
// apps/opencroft/components/code-editor.tsx — the two are the same type
// written twice, because this package deliberately declares rather than
// imports the runtime it describes.
export type CodeEditorLanguage = 'typescript' | 'javascript' | 'python' | 'shell' | 'json' | 'plaintext' | (string & {})

/** Which of the two renderings of the same pair of documents is on screen. */
export type CodeEditorDiffMode = 'unified' | 'split'

/**
 * Handed the editor and the `monaco` namespace once the editor is live —
 * @monaco-editor/react's own mount signature, passed straight through.
 *
 * The editor is a union because the two modes are two different editors, and
 * which one arrives follows `original`: given -> a diff editor, omitted -> an
 * ordinary one. A caller that takes both narrows at run time on the method
 * only the diff has — `'getModifiedEditor' in editor`.
 *
 * `monaco` is the second argument for a reason beyond convenience. Reaching
 * the namespace is the only way to construct the values its own APIs take
 * (`new monaco.Range(...)` for a decoration, say), and an extension bundle is
 * a browser ESM bundle with no runtime module resolver, so importing
 * `monaco-editor` for it is not open to you. Receiving it here is what lets an
 * extension install the `window.monaco` shim it would otherwise have no way to
 * obtain — and it is the host's one namespace, not a second copy.
 */
export type MonacoNamespace = typeof import('monaco-editor')
/** What `onMount` hands over when `original` is omitted. */
export type MonacoCodeEditor = import('monaco-editor').editor.IStandaloneCodeEditor
/** What `onMount` hands over when `original` is given. */
export type MonacoDiffEditor = import('monaco-editor').editor.IStandaloneDiffEditor

export type CodeEditorOnMount = (editor: MonacoCodeEditor | MonacoDiffEditor, monaco: MonacoNamespace) => void

/**
 * Monaco's folding of long runs of untouched context, in diff mode.
 *
 * Every field is optional and what is left out keeps the host's default, so a
 * caller that cares about one number does not have to restate the other two.
 */
export interface CodeEditorHideUnchangedRegions {
  /** Fold at all. Defaults to true. */
  enabled?: boolean
  /** Runs shorter than this are never folded — folding them saves nothing. Defaults to 4. */
  minimumLineCount?: number
  /** Unchanged lines kept either side of a change. Defaults to 3. */
  contextLineCount?: number
}

export interface CodeEditorProps {
  /** In diff mode (`original` given) this is the modified side. */
  value: string
  /**
   * The unchanged side of a diff. Given -> this renders a diff; omitted -> an
   * ordinary editor.
   *
   * Note that the two modes are two different components underneath
   * (@monaco-editor/react's `Editor` and `DiffEditor`), so flipping `original`
   * between undefined and defined remounts the editor and drops its undo
   * history. That is acceptable for the intended use — a file does not turn
   * into a diff mid-edit — but nothing in the type says so, so it is said here.
   */
  original?: string
  language?: CodeEditorLanguage
  /** Applies to the editable side only; `original` is always read-only. */
  readOnly?: boolean
  onChange?: (value: string) => void
  /** Reveal and place the cursor on this 1-based line once, on mount. */
  line?: number
  /**
   * Defaults to filling its container, which must have a definite height — in
   * diff mode it instead defaults to the content's own height, bounded, because
   * diffs are meant to sit inline in a column of other content.
   */
  height?: string | number
  /**
   * The escape hatch out of these props and into Monaco itself, for the things
   * no prop here can express: decorations, diff-change enumeration, mouse and
   * cursor and scroll subscriptions, pixel positions for an overlay. Without
   * it, an extension that needs any of those has to mount its own editor —
   * which is the one thing sharing this component exists to prevent.
   *
   * See `CodeEditorOnMount` for which editor arrives and how to tell.
   */
  onMount?: CodeEditorOnMount
  /**
   * Which diff rendering to show. Omitted, the mode is the component's own
   * state and its overlaid toggle drives it; given, you own it and this
   * becomes an ordinary controlled prop.
   *
   * For a surface whose diff mode is not the reader's private business but
   * part of a larger state — one already persisted, shared across several
   * diffs at once, or driven from a toolbar that belongs to you.
   */
  diffMode?: CodeEditorDiffMode
  /**
   * Fired when the component's own toggle is pressed. The way to keep that
   * toggle working while `diffMode` is controlled — without it a controlled
   * caller's toggle renders and does nothing, since the state it writes is not
   * the state being displayed.
   */
  onDiffModeChange?: (mode: CodeEditorDiffMode) => void
  /**
   * Draw the overlaid unified/split toggle. Defaults to true.
   *
   * Set false when you already have this control in your own toolbar —
   * otherwise `diffMode` gets you a second toggle sitting on top of the diff,
   * competing with the one you drew yourself.
   */
  showModeToggle?: boolean
  /**
   * Folding of long runs of untouched context, in diff mode. Defaults to
   * `{ enabled: true, minimumLineCount: 4, contextLineCount: 3 }`; an object
   * given here is merged over that, so naming one field keeps the others.
   *
   * `false` is the shorthand for showing the whole file, which is what a
   * caller offering its own "show full file" control needs — and also what a
   * caller revealing a deep-linked `line` needs, because folding can close
   * over the very line being revealed.
   */
  hideUnchangedRegions?: false | CodeEditorHideUnchangedRegions
}

/**
 * The host's code editor, in either of two modes: an ordinary editor, or —
 * given `original` — a diff against it, with a unified/split toggle of its own
 * that `diffMode` / `showModeToggle` let you take over.
 *
 * Provided here rather than imported from an editor package so every surface
 * shares one editor runtime — an extension bundle has no runtime module
 * resolver, so its own copy would initialise a second one.
 *
 * `onMount` is the way out of these props when they run out: it hands over the
 * editor and the `monaco` namespace, which between them reach everything
 * Monaco can do without a second editor being mounted to get at it.
 */
export declare const CodeEditor: FC<CodeEditorProps>
