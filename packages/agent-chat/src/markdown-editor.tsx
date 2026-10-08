'use client'

import { Dropcursor, Gapcursor, Placeholder, TrailingNode, UndoRedo } from '@tiptap/extensions'
import { type Node as ProseMirrorNode, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { type AnyExtension, type Editor, EditorContent, Extension, useEditor } from '@tiptap/react'
import { cn } from 'cn'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'

import { prepareLanguage, resolveLanguage, tokenize } from './components/code-highlight'
import { directiveBlockViews } from './markdown-editor-blocks'
import { CodeBlockNode } from './markdown-editor-code-block'
import { IconNode } from './markdown-editor-icon'
import { MarkdownEditorReferences } from './markdown-editor-references'
import { markdownConverter, markdownSchemaExtensions } from './markdown-editor-schema'
import { createSlashMenuStore, SlashMenu, SlashMenuPopup, type SlashMenuStore } from './markdown-editor-slash-menu'
import { MarkdownTableEditing, MarkdownTableNode } from './markdown-editor-table'
import { ALL_TOOLBAR_GROUPS, type MarkdownEditorToolbarGroup, Toolbar } from './markdown-editor-toolbar'

export type { MarkdownEditorToolbarGroup }

/*
 * For whoever next syncs this package with the product it is a subtree of.
 *
 * This file replaces `src/skill-editor.tsx`, which is deleted: the two markdown
 * WYSIWYGs in this product -- the skill body editor that lived there and the
 * documentation extension's page editor -- are now this one component, and the
 * package's `SkillEditor` export is now `MarkdownEditor`. The editor was not
 * merely moved: the package went from TipTap 2.11 to 3.31, which is a
 * breaking major, and it reads and writes markdown through TipTap's own
 * `@tiptap/markdown` (`./markdown-editor-markdown`), which replaced
 * `tiptap-markdown` and `markdown-it-container`.
 *
 * The markdown it writes is the same as before for what this product stores,
 * with the differences listed in `./markdown-editor-markdown` and its tests:
 * a line break inside a paragraph's source reads as a space, HTML other than
 * `<br>` reads as its own characters, underline is gone (markdown has none),
 * and GFM task items keep their boxes. A consumer whose stored markdown leans
 * on raw HTML should check it against those tests at the sync.
 *
 * A consumer outside this repository therefore has two things to do at the
 * sync, and neither can be checked from here: point whatever rendered
 * `SkillEditor` at `MarkdownEditor` (the props are the same `value` /
 * `onChange` / `className`), and re-check any OTHER TipTap code it keeps
 * against 3.x. The two v3 changes that bite silently rather than loudly are in
 * this file and its toolbar: `setContent`'s second argument is an options
 * object now, so a v2 `setContent(value, false)` still compiles as `{}` and
 * starts emitting the change events it was written to suppress; and
 * `useEditor` no longer re-renders on every transaction, so a toolbar that
 * reads `editor.isActive()` during render type-checks and then shows stale
 * active states until something else re-renders it -- `useEditorState` is the
 * replacement, used in `./markdown-editor-toolbar`.
 */

/*
 * Why this is here and not in `src/components`, where its neighbours are.
 *
 * `src/components` is the design kit's, and a component that lives there has to
 * be created in the kit, published, and mirrored back identically. This one was
 * written there first and moved out, for a reason the kit measured rather than a preference:
 * the kit's preview sandbox has no TipTap in it, so the component cannot be
 * evaluated there at all (`Extension` comes back undefined and
 * `Extension.create` throws). A kit entry that can never render is one nobody
 * can review, and it would leave `validateComponent` failing for the whole
 * shared project -- the same argument `./components/code-highlight` already
 * makes for avoiding `new Map()` in a previewable file.
 *
 * `./components/code-highlight` IS kit-tracked, and the tokenizer this file
 * uses was added to it through the kit and published (code-block v4), so the
 * two copies of that file stay identical. Moving this component back under
 * `src/components` means getting TipTap into the kit's sandbox first.
 *
 * The same split holds for the documentation blocks: how a callout, a spoiler,
 * tabs and the `/` menu LOOK is kit components under `src/components`, which
 * know nothing of TipTap; the TipTap nodes that draw through them are the
 * `./markdown-editor-*` files beside this one.
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
  collaboration?: never
}

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
}

export type MarkdownEditorProps = MarkdownEditorSurfaceProps &
  (MarkdownEditorOwnDocument | MarkdownEditorSharedDocument)

/** How the editor looks and behaves, whichever document it edits. */
export interface MarkdownEditorSurfaceProps {
  /** Shown while the document is empty. Read once, when the editor is created. */
  placeholder?: string
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
// The editor's own, whatever the look: no focus ring (the box around it
// carries the border), and a full-height click target so clicking the empty
// space below the last paragraph puts the caret in it.
const CONTENT_CLASS = 'markdown-editor min-h-full focus:outline-none'

/** The editor's document as markdown. */
export function readMarkdown(editor: Editor): string {
  return markdownConverter().serialize(editor.getJSON())
}

/** Markdown as the editor's content. */
export function markdownContent(markdown: string) {
  return markdownConverter().parse(markdown)
}

/*
 * Plain text pasted into the editor is read as markdown, so a pasted page
 * arrives as the page it is. Shift-paste keeps it plain text, and a paste
 * carrying HTML is ProseMirror's own.
 */
const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: {
          clipboardTextParser: (text, _context, plain, view) => {
            if (plain) {
              return null as unknown as Slice
            }
            const doc = view.state.schema.nodeFromJSON(markdownContent(text))
            return Slice.maxOpen(doc.content)
          },
        },
      }),
    ]
  },
})

/*
 * Code blocks are coloured by the same highlighter as everything else on the
 * page -- `./components/code-highlight`, one shiki instance and one grammar cache shared
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
    // A plain object rather than a Set, for the reason `code-highlight` keeps
    // one: the design kit's preview sandbox puts every lucide icon in scope by
    // its bare name, and shadowed globals fail there and nowhere else.
    const requested: Record<string, boolean> = {}
    const request = (language: string) => {
      if (requested[language]) {
        return
      }
      requested[language] = true
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
 * documentation blocks, icons and the `/` menu. One list, so anything that builds an
 * editor outside the component -- a test -- builds this one.
 *
 * Headings, lists, quotes, code and the divider are typed as their markdown
 * (`#`, `-` / `*`, `>`, backticks, `---` at a line start). Those input rules
 * are StarterKit's own.
 */
export function markdownEditorExtensions({
  placeholder,
  slashMenu,
  collaboration,
}: {
  placeholder?: string
  /** Where the `/` menu reports; without one there is no `/` menu. */
  slashMenu?: SlashMenuStore
  /** Binds a shared document; see `MarkdownEditorSharedDocument`. */
  collaboration?: AnyExtension[]
}): AnyExtension[] {
  return [
    // The document: schema and markdown, with the nodes the editor draws.
    ...markdownSchemaExtensions([...directiveBlockViews, IconNode, MarkdownTableNode, CodeBlockNode]),
    // A shared document's history is its binding's. So is its content: the
    // trailing empty paragraph an editor keeps for the caret would be added to
    // the shared document by every editor that opened it.
    ...(collaboration ?? [UndoRedo, TrailingNode]),
    Dropcursor,
    Gapcursor,
    MarkdownTableEditing,
    MarkdownPaste,
    Placeholder.configure({ placeholder: placeholder ?? '' }),
    CodeBlockHighlight,
    // Identifiers the installed reference source recognises, styled in place.
    MarkdownEditorReferences,
    ...(slashMenu ? [SlashMenu.configure({ store: slashMenu })] : []),
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
  placeholder,
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

  const [slashMenu] = useState(createSlashMenuStore)

  const editor = useEditor({
    // Deferred to the client to avoid an SSR hydration mismatch.
    immediatelyRender: false,
    autofocus: autoFocus ? 'end' : false,
    extensions: markdownEditorExtensions({ placeholder, slashMenu, collaboration }),
    content: value === undefined ? undefined : markdownContent(value),
    editable,
    onUpdate: ({ editor }) => onChangeRef.current?.(readMarkdown(editor)),
    editorProps: {
      attributes: {
        class: cn(CONTENT_CLASS, contentClassName ?? DEFAULT_CONTENT_CLASS),
      },
    },
  })

  // Load a different document into the editor without reporting it as an edit.
  // The comparison is what keeps this from fighting the caller: the value that
  // came back from our own `onChange` is already what the editor holds, and
  // re-setting it would collapse the selection on every keystroke.
  useEffect(() => {
    if (editor && !editor.isDestroyed && value !== undefined && value !== readMarkdown(editor)) {
      editor.commands.setContent(markdownContent(value), { emitUpdate: false })
    }
  }, [value, editor])

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) {
      editor.setEditable(editable)
    }
  }, [editable, editor])

  if (!editor) {
    // Same box, so the surface does not jump when the editor arrives.
    return <div className={cn('rounded-md border bg-background', className)} />
  }

  return (
    <Flex className={cn('rounded-md border bg-background min-h-0', className)}>
      {toolbar === false ? null : (
        <Toolbar editor={editor} groups={toolbar} extra={toolbarExtra} className={toolbarClassName} />
      )}
      {/* Layout containment makes the text area the box that anything positioned
          inside it is laid out against, fixed included. An overlay drawn over the
          text -- a collaborator's name tag -- then stays in the text area: it
          scrolls with the text and goes under the toolbar with it, while the
          boxes inside the text (a table's frame) neither clip it nor scroll. */}
      <EditorContent editor={editor} className='flex-1 min-h-0 overflow-y-auto contain-layout' />
      <SlashMenuPopup store={slashMenu} />
    </Flex>
  )
}
