'use client'

import { Extension } from '@tiptap/core'
import { Dropcursor, Gapcursor, Placeholder, TrailingNode, UndoRedo } from '@tiptap/extensions'
import { type Node as ProseMirrorNode, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { type AnyExtension, type Editor, EditorContent, type JSONContent, useEditor } from '@tiptap/react'
import { cn } from 'cn'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { agentMarkdownConverter, readAgentPaste } from './agent-markdown'
import { prepareLanguage, resolveLanguage, tokenize } from './code-highlight'
import { MARKDOWN_HINT_MARK_CLASS } from './markdown-hint'
import type { MentionCandidate } from './mention-autocomplete'
import type { BlockInsert } from './markdown-editor-block-inserts'
import { directiveBlockViews } from './markdown-editor-blocks'
import { CodeBlockNode } from './markdown-editor-code-block'
import { FieldMenus } from './markdown-editor-field-menus'
import {
  MARKDOWN_EDITOR_FIELD_TEXT_CLASS,
  MarkdownEditorBox,
  MarkdownEditorPlaceholder,
  type MarkdownEditorVariant,
} from './markdown-editor-frame'
import { HintPopover } from './markdown-editor-hint'
import { HintMark } from './markdown-editor-hint-mark'
import { IconNode } from './markdown-editor-icon'
import { InlineEdit } from './markdown-editor-inline-edit'
import { LinkEditing, LinkPopover } from './markdown-editor-link'
import { MarkdownEditorReferences } from './markdown-editor-references'
import { markdownConverter, markdownSchemaExtensions } from './markdown-editor-schema'
import { MentionMenu, MentionMenuPopup, type MentionMenuStore } from './markdown-editor-mention-menu'
import type { MarkdownMentionSource } from './markdown-mentions'
import { SlashMenu, SlashMenuPopup, type SlashMenuStore } from './markdown-editor-slash-menu'
import { createSuggestionMenuStore } from './markdown-editor-suggestion-menu'
import { MarkdownTableEditing, MarkdownTableNode } from './markdown-editor-table'
import { isTitle, TITLE_PLACEHOLDER, TitleHeading } from './markdown-editor-title'
import { ALL_TOOLBAR_GROUPS, type MarkdownEditorToolbarGroup, Toolbar } from './markdown-editor-toolbar'

export type { MarkdownEditorToolbarGroup, MarkdownEditorVariant }

/*
 * The design kit's Markdown Editor: this file and the `./markdown-editor-*`
 * files beside it. Both looks are drawn from one set of parts: the frames in
 * `./markdown-editor-frame`, the toolbar, and the menus built from the same
 * actions. How a callout, a spoiler, tabs, the `/` menu and the `@` list look
 * is their own kit components, which know nothing of TipTap; the TipTap nodes
 * here draw through them.
 */

/** A document the caller holds as markdown. */
export interface MarkdownEditorOwnDocument {
  /**
   * The markdown being edited. Controlled -- the caller holds it, and markdown
   * is what both the editor reads and what `onChange` reports, because markdown
   * is what every caller here stores.
   */
  value: string
  onChange: (markdown: string) => void
  /**
   * How the markdown is written and read; see `MarkdownEditorDialect`. Read
   * once, when the editor is created.
   */
  dialect?: MarkdownEditorDialect
  collaboration?: never
}

/**
 * `document` (default): the documents' markdown, for a page of text. A line
 * break inside a paragraph's source reads as a space, `<` and `>` are written
 * as entities, and markdown syntax characters with a backslash.
 *
 * `agent`: for text read as written -- by an agent that takes it raw -- as
 * well as drawn. A line break is written as a newline and read back as one,
 * and a character is escaped with a backslash only where `Markdown` would
 * read it as syntax. Pasted text is read the same way, a Shift-paste as typed.
 * Draw such text with `Markdown` and `lineBreaks`.
 */
export type MarkdownEditorDialect = 'document' | 'agent'

/** A document several editors share, held by whatever the extensions bind it to. */
export interface MarkdownEditorSharedDocument {
  /**
   * Extensions that bind the editor to a shared document -- TipTap's
   * `Collaboration` and anything that goes with it. The document and its undo
   * history are theirs: the editor neither loads content nor keeps a history
   * of its own. Read once, when the editor is created.
   */
  collaboration: AnyExtension[]
  value?: never
  onChange?: never
  /** A shared document's markdown is its binding's, written in the documents' dialect. */
  dialect?: never
}

export type MarkdownEditorProps = MarkdownEditorSurfaceProps &
  (MarkdownEditorOwnDocument | MarkdownEditorSharedDocument)

/** How the editor looks and behaves, whichever document it edits. */
export interface MarkdownEditorSurfaceProps {
  /**
   * `toolbar` (default): a box with the toolbar on top. Multi-line text always
   * uses it.
   * `field`: a flat input field with no frame and no toolbar, for content that
   * may well be a single line, such as a message in a messenger or a comment
   * on a task. Right-click is the browser's own menu, with its spelling
   * suggestions. Selected text gets a bar with Bold, Italic, Inline code, Link,
   * Clear formatting and `⋮`, which turns the bar into a list of everything
   * else the toolbar offers except Undo and Redo, the block styles at its top
   * level, and the table's actions in a table. The bar is above the selection,
   * or below it on a touch screen, where the platform's own selection menu is
   * above. Using it never takes focus from the text. The `toolbar*` props do
   * not apply to it.
   */
  variant?: MarkdownEditorVariant
  /** Shown while the document is empty. Read once, when the editor is created. */
  placeholder?: string
  /**
   * The document starts with its title: the first block is always a level-1
   * heading, shown as "Title" while empty, which can be emptied but not
   * removed or made another kind of block. Read once, when the editor is
   * created.
   */
  titleHeading?: boolean
  /** Editable by default; `false` renders the same prose read-only. */
  editable?: boolean
  /** Put the caret at the end of the document on mount. */
  autoFocus?: boolean
  /** Toolbar groups, in the order given. Defaults to all of them; `false` for no toolbar. */
  toolbar?: false | MarkdownEditorToolbarGroup[]
  /**
   * Rendered at the end of the toolbar row, after a spacer. For a surface whose
   * own actions belong on that row rather than above it -- the documentation
   * editor's commit message, publish and discard controls are there.
   */
  toolbarExtra?: ReactNode
  /**
   * Added to the toolbar row. For a surface where the editor grows with its
   * content and the PAGE scrolls rather than the editor: the toolbar there has
   * to be `sticky` to stay reachable, which the editor cannot decide for itself
   * because it depends on which box is the scrolling one.
   */
  toolbarClassName?: string
  /** Added to the editor's outer box, for the layout your surface needs. */
  className?: string
  /**
   * Classes for the editable area itself, REPLACING the default look -- prose
   * scale and inset both -- rather than adding to it. A surface that renders
   * the same markdown with another scale (the documentation page, `prose-docs`)
   * passes that scale here, and no inset, so the text it edits sits exactly
   * where its rendered view puts it.
   */
  contentClassName?: string
}

// The editable area's default look: the chat's prose scale, the same one
// `Markdown` renders a message with, so text written here looks like the text
// it becomes -- inset from the box's border, since this editor draws one.
const DEFAULT_CONTENT_CLASS = 'prose-chat max-w-none p-3'
// The field's: the same prose, placed as the field places its text.
const FIELD_CONTENT_CLASS = cn('prose-chat max-w-none', MARKDOWN_EDITOR_FIELD_TEXT_CLASS)
// The editor's own, whatever the look: no focus ring (the box around it
// carries the border), and a full-height click target so clicking the empty
// space below the last paragraph puts the caret in it.
export const MARKDOWN_EDITOR_CONTENT_CLASS = 'markdown-editor min-h-full focus:outline-none'

function converterOf(dialect: MarkdownEditorDialect) {
  return dialect === 'agent' ? agentMarkdownConverter() : markdownConverter()
}

/** The editor's document as markdown. */
export function readMarkdown(editor: Editor, dialect: MarkdownEditorDialect = 'document'): string {
  return converterOf(dialect).serialize(editor.getJSON())
}

/** Markdown as the editor's content. */
export function markdownContent(markdown: string, dialect: MarkdownEditorDialect = 'document') {
  return converterOf(dialect).parse(markdown)
}

/*
 * `next` as the editor will hold it. After a last block that is not a
 * paragraph (a list, table, heading, code block or quote) the editor keeps an
 * empty paragraph for the caret (`TrailingNode`), which no markdown carries.
 * Without it in `next` the two documents differ at their very end, the diff
 * runs from the first change to the end of the document, and a caret or an
 * undo step anywhere in that range is lost.
 */
function withTrailingParagraph(doc: ProseMirrorNode, next: ProseMirrorNode): ProseMirrorNode {
  const kept = doc.lastChild
  const last = next.lastChild
  if (!(kept?.type.name === 'paragraph' && kept.content.size === 0) || last?.type.name === 'paragraph') {
    return next
  }
  return next.copy(next.content.addToEnd(kept.type.create()))
}

/**
 * Puts `markdown` in the editor as a change that arrived from elsewhere -- a
 * new value from the caller, typically someone else's edit to the document
 * this person has open. Only the range that differs is replaced, so a caret
 * outside it stays where it was, and the change is no step of this person's
 * undo history: undo reverts their own edits, not what arrived meanwhile.
 * Nothing is reported through `onChange`.
 */
export function loadMarkdown(editor: Editor, markdown: string, dialect: MarkdownEditorDialect = 'document'): void {
  const { doc, schema } = editor.state
  const next = withTrailingParagraph(doc, schema.nodeFromJSON(markdownContent(markdown, dialect)))
  const start = doc.content.findDiffStart(next.content)
  const end = doc.content.findDiffEnd(next.content)
  if (start === null || !end) {
    return
  }
  // Where the change repeats what is beside it ("ab" to "abab"), the scan from
  // the end runs back past where the scan from the start stopped; both ends
  // move forward by the overlap, which describes the same change.
  const overlap = start - Math.min(end.a, end.b)
  const endA = overlap > 0 ? end.a + overlap : end.a
  const endB = overlap > 0 ? end.b + overlap : end.b
  const tr = editor.state.tr.replace(start, endA, next.slice(start, endB))
  editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('preventUpdate', true))
}

/**
 * Reads text pasted into the editor as a document: as markdown, or, for a
 * Shift-paste (`plain`), as plain text. `null` leaves the text to ProseMirror,
 * which makes each line a paragraph.
 */
export type MarkdownPasteReader = (text: string, plain: boolean) => JSONContent | null

/*
 * Plain text pasted into the editor is read as markdown, so a pasted page
 * arrives as the page it is. Shift-paste keeps it plain text, and a paste
 * carrying HTML is ProseMirror's own.
 */
const readPastedMarkdown: MarkdownPasteReader = (text, plain) => (plain ? null : markdownContent(text))

const MarkdownPaste = Extension.create<{ read: MarkdownPasteReader }>({
  name: 'markdownPaste',
  addOptions() {
    return { read: readPastedMarkdown }
  },
  addProseMirrorPlugins() {
    const { read } = this.options
    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: {
          clipboardTextParser: (text, _context, plain, view) => {
            const content = read(text, plain)
            if (!content) {
              return null as unknown as Slice
            }
            return Slice.maxOpen(view.state.schema.nodeFromJSON(content).content)
          },
        },
      }),
    ]
  },
})

/*
 * A key pressed right after a click acts where the click put the caret.
 *
 * ProseMirror reads a click's caret from the browser's `selectionchange`,
 * which Chrome delivers as a task of its own, 4-12 ms after `mouseup` in the
 * inspector (measured 2026-10-29). A keydown dispatched before that task runs
 * is handled at the caret from before the click: Enter splits the block the
 * caret was in before, at the top of the document on a first click. Nobody
 * types that fast; an agent driving the page does. So the keydown runs ProseMirror's own handling of that
 * event first. When the caret has not moved, that handling changes nothing.
 *
 * `domObserver` is not in ProseMirror's typed API (prosemirror-view 1.42),
 * hence the cast. The call is optional so a release that renames it costs this
 * fix, not the keyboard; `markdown-editor-load.test.tsx` fails if that happens.
 */
const CaretBeforeKey = Extension.create({
  name: 'caretBeforeKey',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('caretBeforeKey'),
        props: {
          handleDOMEvents: {
            keydown: (view) => {
              ;(view as unknown as { domObserver?: { onSelectionChange?: () => void } }).domObserver?.onSelectionChange?.()
              return false
            },
          },
        },
      }),
    ]
  },
})

/*
 * Code blocks are coloured by the same highlighter as everything else on the
 * page -- `./code-highlight`, one shiki instance and one grammar cache shared
 * with `CodeBlock`, `CodeBlockEditor` and `Markdown`.
 *
 * That is why this is hand-written rather than `tiptap-extension-code-block-shiki`,
 * which is the obvious dependency to reach for: that package calls shiki's own
 * `createHighlighter` internally with no way to pass an instance in, so adopting
 * it would mean a second highlighter on the page -- a second grammar cache
 * re-downloading what the chat already holds, and the oniguruma wasm engine that
 * `code-highlight` deliberately does not use.
 *
 * The mechanism is the one `@tiptap/extension-code-block-lowlight` uses:
 * inline decorations over the code block's text, so the text itself stays
 * ordinary editable ProseMirror content and typing in a coloured block is
 * typing in a code block. Unlike lowlight, shiki cannot tokenize until the
 * grammar has arrived, so a block renders uncoloured and the plugin asks again
 * when `prepareLanguage` resolves.
 */
const codeHighlightKey = new PluginKey<DecorationSet>('markdownEditorCodeHighlight')

function codeBlockDecorations(doc: ProseMirrorNode, request: (language: string) => void): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') {
      return true
    }
    const language = resolveLanguage(node.attrs.language as string | undefined)
    if (!language) {
      return false
    }
    const tokens = tokenize(node.textContent, language)
    if (!tokens) {
      request(language)
      return false
    }
    // A code block holds text and nothing else, so an offset into its text is
    // `pos + 1` in the document -- one for the block's own opening token.
    for (const token of tokens) {
      decorations.push(
        Decoration.inline(pos + 1 + token.start, pos + 1 + token.end, {
          class: 'shiki-token',
          style: token.style,
        }),
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

const CodeBlockHighlight = Extension.create({
  name: 'codeBlockHighlight',
  addProseMirrorPlugins() {
    let view: EditorView | null = null
    const requested = new Set<string>()
    const request = (language: string) => {
      if (requested.has(language)) {
        return
      }
      requested.add(language)
      void prepareLanguage(language).then((loaded) => {
        // The editor can be gone by the time a grammar arrives; `view` is
        // nulled when the plugin's view is destroyed.
        if (loaded && view) {
          view.dispatch(view.state.tr.setMeta(codeHighlightKey, true))
        }
      })
    }
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightKey,
        state: {
          init: (_config, state) => codeBlockDecorations(state.doc, request),
          apply: (tr, current) =>
            tr.docChanged || tr.getMeta(codeHighlightKey)
              ? codeBlockDecorations(tr.doc, request)
              : // Mapped rather than rebuilt: a selection change moves nothing,
                // and re-tokenizing every code block on every caret move would
                // be work proportional to the document for no visible change.
                current.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => codeHighlightKey.getState(state),
        },
        view: (editorView) => {
          view = editorView
          return {
            destroy: () => {
              view = null
            },
          }
        },
      }),
    ]
  },
})

/**
 * Everything the editor is made of: the schema, the markdown both ways, the
 * documentation blocks, icons, the `/` menu and the `@` list. One list, so anything that builds an
 * editor outside the component -- a test -- builds this one.
 *
 * Headings, lists, quotes, code and the divider are typed as their markdown
 * (`#`, `-` / `*`, `>`, backticks, `---` at a line start). Those input rules
 * are StarterKit's own.
 */
export function markdownEditorExtensions({
  placeholder,
  titleHeading,
  slashMenu,
  mentionMenu,
  mentionSource,
  readPaste,
  collaboration,
}: {
  placeholder?: string
  /** See `MarkdownEditorSurfaceProps.titleHeading`. */
  titleHeading?: boolean
  /** Where the `/` menu reports; without one there is no `/` menu. */
  slashMenu?: SlashMenuStore
  /** Where the `@` list reports; without one there is no `@` list. */
  mentionMenu?: MentionMenuStore
  /** Whom the `@` list offers; the installed source by default. */
  mentionSource?: () => MarkdownMentionSource | null
  /** How pasted text is read; as the editor's markdown by default. */
  readPaste?: MarkdownPasteReader
  /** Binds a shared document; see `MarkdownEditorSharedDocument`. */
  collaboration?: AnyExtension[]
}): AnyExtension[] {
  return [
    // The document: schema and markdown, with the nodes the editor draws.
    ...markdownSchemaExtensions([
      ...directiveBlockViews,
      IconNode,
      MarkdownTableNode,
      CodeBlockNode,
      // Marked in the text as the page marks it.
      HintMark.configure({ HTMLAttributes: { class: MARKDOWN_HINT_MARK_CLASS } }),
    ]),
    // A shared document's history is its binding's. So is its content: the
    // trailing empty paragraph an editor keeps for the caret would be added to
    // the shared document by every editor that opened it.
    ...(collaboration ?? [UndoRedo, TrailingNode]),
    Dropcursor,
    Gapcursor,
    MarkdownTableEditing,
    readPaste ? MarkdownPaste.configure({ read: readPaste }) : MarkdownPaste,
    CaretBeforeKey,
    // The placeholder marks the empty block the caret is in too, so it has to
    // say the same as the title's own while that block is the title.
    Placeholder.configure({
      placeholder: ({ node, pos }) => (titleHeading && pos === 0 && isTitle(node) ? TITLE_PLACEHOLDER : (placeholder ?? '')),
    }),
    CodeBlockHighlight,
    // Identifiers the installed reference source recognises, styled in place.
    MarkdownEditorReferences,
    // Links and hints are added and edited in a popover above the text.
    InlineEdit,
    LinkEditing,
    ...(slashMenu ? [SlashMenu.configure({ store: slashMenu })] : []),
    ...(mentionMenu
      ? [MentionMenu.configure({ store: mentionMenu, ...(mentionSource ? { source: mentionSource } : {}) })]
      : []),
    ...(titleHeading ? [TitleHeading] : []),
  ]
}

/**
 * A markdown WYSIWYG: rich text in, markdown out.
 *
 * Controlled on markdown in both directions, because markdown is the storage
 * format for everything edited this way -- an agent skill's instruction body, a
 * documentation page. The editor never holds a representation the caller cannot
 * see. A document several people edit at once is the exception: it is bound
 * through `collaboration` instead, and its markdown is whatever holds it.
 */
export function MarkdownEditor({
  value,
  onChange,
  collaboration,
  dialect: dialectProp,
  variant = 'toolbar',
  placeholder,
  titleHeading,
  editable = true,
  autoFocus = false,
  toolbar = ALL_TOOLBAR_GROUPS,
  toolbarExtra,
  toolbarClassName,
  className,
  contentClassName,
}: MarkdownEditorProps) {
  // The editor is created once and keeps the `onUpdate` it was created with, so
  // the handler reads the current `onChange` through a ref instead of closing
  // over the first one -- a caller whose callback is not memoised would
  // otherwise keep reporting into a stale closure.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // The markdown the caller already has: the `value` it passed, or what was last
  // reported to it. A transaction can change the document without changing its
  // markdown -- the trailing paragraph kept after a final code block or table
  // is added on the first transaction of any kind, a highlighter's included --
  // and reporting that would tell the caller an untouched document was edited.
  const knownMarkdownRef = useRef(value)
  useEffect(() => {
    knownMarkdownRef.current = value
  }, [value])

  const [slashMenu] = useState(createSuggestionMenuStore<BlockInsert>)
  const [mentionMenu] = useState(createSuggestionMenuStore<MentionCandidate>)
  // Read once, as the editor is: it is made with the dialect's paste reader.
  const [dialect] = useState<MarkdownEditorDialect>(dialectProp ?? 'document')
  const agent = dialect === 'agent'
  const field = variant === 'field'

  const editor = useEditor({
    // Deferred to the client to avoid an SSR hydration mismatch.
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    extensions: markdownEditorExtensions({
      placeholder,
      titleHeading,
      slashMenu,
      mentionMenu,
      collaboration,
      readPaste: agent ? readAgentPaste : undefined,
    }),
    // The agent dialect's paste reader has read any markdown in pasted text.
    // Paste rules would read the text it left again, bolding a Shift-pasted
    // `__init__`.
    enablePasteRules: !agent,
    content: value === undefined ? undefined : markdownContent(value, dialect),
    editable,
    onUpdate: ({ editor }) => {
      const markdown = readMarkdown(editor, dialect)
      if (markdown === knownMarkdownRef.current) {
        return
      }
      knownMarkdownRef.current = markdown
      onChangeRef.current?.(markdown)
    },
    editorProps: {
      attributes: {
        class: cn(MARKDOWN_EDITOR_CONTENT_CLASS, contentClassName ?? (field ? FIELD_CONTENT_CLASS : DEFAULT_CONTENT_CLASS)),
      },
    },
  })

  // Take in a `value` the editor does not hold yet without reporting it as an
  // edit. The comparison is what keeps this from fighting the caller: the value
  // that came back from our own `onChange` is already what the editor holds.
  useEffect(() => {
    if (editor && !editor.isDestroyed && value !== undefined && value !== readMarkdown(editor, dialect)) {
      loadMarkdown(editor, value, dialect)
    }
  }, [value, editor, dialect])

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) {
      editor.setEditable(editable)
    }
  }, [editable, editor])

  if (!editor) {
    return <MarkdownEditorPlaceholder variant={variant} className={className} contentClassName={contentClassName} />
  }

  // Layout containment makes the text area the box that anything positioned
  // inside it is laid out against, fixed included. An overlay drawn over the
  // text -- a collaborator's name tag -- then stays in the text area: it
  // scrolls with the text and goes under the toolbar with it, while the boxes
  // inside the text (a table's frame) neither clip it nor scroll.
  const text = <EditorContent editor={editor} className='flex-1 min-h-0 overflow-y-auto contain-layout' />
  const popups = (
    <>
      <SlashMenuPopup store={slashMenu} />
      <MentionMenuPopup store={mentionMenu} />
      <LinkPopover editor={editor} />
      <HintPopover editor={editor} />
    </>
  )

  if (field) {
    return (
      <>
        <FieldMenus editor={editor} className={className}>
          {text}
        </FieldMenus>
        {popups}
      </>
    )
  }

  return (
    <MarkdownEditorBox className={className}>
      {toolbar === false ? null : (
        <Toolbar editor={editor} groups={toolbar} extra={toolbarExtra} className={toolbarClassName} />
      )}
      {text}
      {popups}
    </MarkdownEditorBox>
  )
}
