'use client'

import { Slice } from '@tiptap/pm/model'
import { type EditorState, Selection, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { type Editor, EditorContent, Extension, useEditor } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import type { AvailableCommand } from 'agent-client/types'
import { cn } from 'cn'
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

import { agentMarkdownConverter, readAgentPaste, typedDoc } from './components/agent-markdown'
import {
  AgentCommandBar,
  type AgentCommandBarComposer,
  type AgentCommandBarProps,
  type AgentCommandBarSuggestions,
  filesFrom,
} from './components/agent-command-bar'
import { commandInvocation, commandToken, matchCommands } from './components/command-autocomplete'
import { filterMentions, type MentionCandidate } from './components/mention-autocomplete'
import { MARKDOWN_EDITOR_CONTENT_CLASS, markdownEditorExtensions, readMarkdown } from './components/markdown-editor'
import { FieldMenus } from './components/markdown-editor-field-menus'
import { HintPopover } from './components/markdown-editor-hint'
import { LinkPopover } from './components/markdown-editor-link'
import {
  createSuggestionMenuStore,
  SUGGESTION_MENU_PRIORITY,
  type SuggestionMenuStore,
  suggestionMenuRender,
} from './components/markdown-editor-suggestion-menu'

/*
 * The chat composer's text: the markdown editor as a field, writing the agent
 * dialect (`./components/agent-markdown`), so a message is formatted as it is written and
 * reaches the agent as typed. The command bar places it and draws its lists;
 * everything about the text itself is here.
 */

/** What a host can do with the composer's text from outside. */
export interface ChatComposerHandle {
  /** Puts focus in the text, the caret where it was. */
  focus(): void
  /** Puts focus in the text, the caret at its end. */
  focusEnd(): void
}

export interface ChatComposerOptions {
  /** The message as markdown. Read when the composer starts and on every new `valueRevision`. */
  value: string
  /**
   * Bumped by the host every time it loads `value` from outside, as opposed
   * to echoing back what was typed: only then is `value` put in the text. An
   * echo is the text already there, and putting it back would move the caret.
   */
  valueRevision?: number
  /** The message as markdown, on every edit. */
  onValueChange: (text: string) => void
  /**
   * Called with the trimmed message. The text is cleared, and reported
   * cleared, before this runs, so a host that persists drafts drops its draft
   * in the same turn and a host whose send fails is the one that puts it back.
   */
  onSend: (text: string) => void
  /** Escape with no list open. Given, it is called instead of clearing the text. */
  onEscape?: () => void
  placeholder?: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  /** A send is in flight, or the agent cannot take one: Enter sends nothing. */
  sending?: boolean
  disabled?: boolean
  /**
   * Commands the agent advertised for the session. With any given, a `/` (or
   * the `$` a name is spelled with) that starts the message offers them.
   */
  commands?: readonly AvailableCommand[]
  /**
   * Who a message can mention. With any given, an `@` at a line start or
   * after whitespace offers them, narrowed as the reader types.
   */
  mentions?: readonly MentionCandidate[]
  /** Pictures pasted into the text or dropped on it. Without it they are refused, and a paste's plain text beside them goes in: a picture is never part of the text. */
  onFiles?: (files: File[]) => void
  inputRef?: Ref<ChatComposerHandle>
}

const chat = agentMarkdownConverter()

type CommandMenuStore = SuggestionMenuStore<AvailableCommand>

/**
 * The agent's commands, offered while the whole message is a command being
 * typed (`commandToken`): `/rev`, or `$sk` for a name spelled with a dollar.
 * Choosing one writes its invocation and a space, which settles it.
 */
const ChatCommandMenu = Extension.create<{
  store: CommandMenuStore | null
  commands: () => readonly AvailableCommand[]
}>({
  name: 'chatCommandMenu',
  priority: SUGGESTION_MENU_PRIORITY,
  addOptions() {
    return { store: null, commands: () => [] }
  },
  addProseMirrorPlugins() {
    const { store, commands } = this.options
    if (!store) {
      return []
    }
    return [
      Suggestion<AvailableCommand, AvailableCommand>({
        editor: this.editor,
        pluginKey: new PluginKey('chatCommandMenu'),
        char: '/',
        findSuggestionMatch: ({ $position }) => {
          const { doc } = $position
          const block = doc.firstChild
          if (doc.childCount !== 1 || !block || $position.parent !== block) {
            return null
          }
          const start = 1
          const text = doc.textBetween(start, start + block.content.size, '\n', '\n')
          const token = commandToken(text)
          if (token === null) {
            return null
          }
          const from = start + text.length - text.trimStart().length
          const to = start + text.length
          // The query is the token itself, sigil included: `/` and `$` offer different names.
          return $position.pos > from && $position.pos <= to ? { range: { from, to }, query: token, text: token } : null
        },
        allow: () => commands().length > 0,
        items: ({ query }) => matchCommands(commands(), query) ?? [],
        command: ({ editor, range, props }) => {
          const text = `${commandInvocation(props)} `
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.insertText(text, range.from, range.to)
              tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
              return true
            })
            .run()
        },
        render: suggestionMenuRender(store),
      }),
    ]
  },
})

/** Whether the main pointer is a finger, read when a key is pressed. */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)
}

/**
 * Whether the selection is in the message's own lines: every block of the
 * text it spans is a paragraph straight in the text, rather than a heading,
 * a list, a quote, a table or a code block, each of which has its own use for
 * Enter. Select-all counts like any other selection. The gap cursor, beside
 * a table that starts or ends the text, spans no block and is not in them.
 */
function inPlainLines(state: EditorState): boolean {
  const { doc, selection } = state
  let blocks = 0
  let plain = true
  doc.nodesBetween(selection.from, selection.to, (node) => {
    blocks += 1
    plain &&= node.type.name === 'paragraph'
    return false
  })
  return plain && blocks > 0
}

/**
 * In the message's own lines Enter sends on a mouse and keyboard; on a touch
 * screen, which has no Shift key, it breaks the line and the button sends.
 * Anywhere else Enter is the editor's: a heading goes on in a paragraph below
 * it; in a list, a quote, a table or a code block Enter starts the next item,
 * paragraph or line, and in an empty one it steps out a level, so Enter twice
 * ends a list and Enter again sends. Shift+Enter breaks the line everywhere
 * (the editor's own key). Escape clears.
 *
 * After the suggestion lists, which take these keys while one is open, and
 * ahead of the editor's own keymaps, so Enter sends rather than splitting a
 * paragraph. An Enter that ends an input method's composition reaches no
 * keymap at all: ProseMirror leaves it to the input method.
 */
const ChatComposerKeys = Extension.create<{ submit: () => void; escape: () => void }>({
  name: 'chatComposerKeys',
  priority: SUGGESTION_MENU_PRIORITY - 100,
  addOptions() {
    return { submit: () => {}, escape: () => {} }
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!inPlainLines(this.editor.state)) {
          return false
        }
        if (coarsePointer()) {
          return this.editor.commands.setHardBreak()
        }
        this.options.submit()
        return true
      },
      Escape: () => {
        this.options.escape()
        return true
      },
    }
  },
})

// The message's type and inset: the conversation's prose, as the message will
// read once sent, 6px above and below its line, so at the 20px line of the
// 14px text one line fills the 32px field the bar is laid out around. 16px on
// a phone, where a smaller text zooms the page as it takes focus.
const COMPOSER_CONTENT_CLASS = 'prose-chat max-w-none px-2 py-1.5 text-base md:text-sm'
// The field's own ground, the kit textarea's: none in a light theme, and in a
// dark one the input tint, lighter than the card the bar sits in.
const COMPOSER_FIELD_CLASS = 'min-h-8 rounded-md dark:bg-input/30'

/**
 * The plain text of a paste whose HTML only lays it out as preformatted text,
 * as a code editor copies code: one element styled `white-space: pre`, around
 * a block per line. ProseMirror would read each line as a paragraph. A `pre`
 * it reads as a code block, its lines kept.
 */
function preformattedText(transfer: DataTransfer | null): string | null {
  const html = transfer?.getData('text/html')
  const text = transfer?.getData('text/plain')
  if (!html || !text) {
    return null
  }
  const blocks = [...new DOMParser().parseFromString(html, 'text/html').body.children]
  const only = blocks.length === 1 ? (blocks[0] as HTMLElement) : null
  return only?.style.whiteSpace.startsWith('pre') ? text : null
}

/**
 * Whether ProseMirror takes this paste for a Shift-paste: Shift held, and not
 * as part of Shift+Insert. Its own test, which it doesn't expose
 * (prosemirror-view 1.42), hence the cast.
 */
function plainPaste(view: EditorView): boolean {
  const input = (view as unknown as { input?: { shiftKey?: boolean; lastKeyCode?: number | null } }).input
  return Boolean(input?.shiftKey) && input?.lastKeyCode !== 45
}

/** Puts a pasted document in place of the selection, as ProseMirror's own paste does. */
function insertPaste(view: EditorView, content: ReturnType<typeof readAgentPaste>): void {
  const doc = view.state.schema.nodeFromJSON(content)
  view.dispatch(
    view.state.tr.replaceSelection(Slice.maxOpen(doc.content)).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'),
  )
}

/** Puts `markdown` in the editor as the whole text, the caret at its end, outside the undo history. */
function load(editor: Editor, markdown: string): void {
  const { schema, tr } = editor.state
  const doc = schema.nodeFromJSON(chat.parse(markdown))
  tr.replaceWith(0, tr.doc.content.size, doc.content)
  tr.setSelection(Selection.atEnd(tr.doc))
  editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('preventUpdate', true))
}

/**
 * The composer's text for `AgentCommandBar`: the editable field, whether
 * there is anything to send, the send itself and the list open over it.
 */
export function useChatComposer(options: ChatComposerOptions): AgentCommandBarComposer {
  // The editor keeps the handlers it was created with; they read the current
  // options through this.
  const latest = useRef(options)
  latest.current = options

  const [mentionStore] = useState(createSuggestionMenuStore<MentionCandidate>)
  const [commandStore] = useState(createSuggestionMenuStore<AvailableCommand>)
  // The markdown the host already has: what it loaded, or what was last
  // reported to it. An edit that leaves the markdown as it was is not one.
  const known = useRef(options.value)
  const [text, setText] = useState(options.value)
  const report = (markdown: string) => {
    known.current = markdown
    setText(markdown)
    latest.current.onValueChange(markdown)
  }

  const clear = (editor: Editor) => {
    load(editor, '')
    report('')
  }
  const submit = (allowEmpty: boolean) => {
    const { sending, disabled, onSend } = latest.current
    const message = (editor ? readMarkdown(editor, 'agent') : known.current).trim()
    if ((!message && !allowEmpty) || sending || disabled) {
      return
    }
    if (editor) {
      clear(editor)
    }
    onSend(message)
  }
  const escape = () => {
    if (latest.current.onEscape) {
      latest.current.onEscape()
    } else if (editor) {
      clear(editor)
    }
  }
  const actions = useRef({ submit, escape })
  actions.current = { submit, escape }

  // Files a paste or a drop brought, handed to the host when it takes them;
  // whether it did. A picture is never part of the text: left to the editor,
  // the HTML naming it is read into an image, and a clipboard holding only the
  // picture is pasted by the browser itself, which writes it as a `data:`
  // address.
  const takeFiles = (files: File[]): boolean => {
    const onFiles = latest.current.onFiles
    onFiles?.(files)
    return Boolean(onFiles)
  }

  const editor = useEditor({
    // Deferred to the client to avoid an SSR hydration mismatch.
    immediatelyRender: false,
    autofocus: options.autoFocus ? 'end' : false,
    extensions: [
      ...markdownEditorExtensions({
        placeholder: options.placeholder,
        mentionMenu: mentionStore,
        mentionSource: () => {
          const mentions = latest.current.mentions
          return mentions && mentions.length > 0 ? { search: async (query) => filterMentions(mentions, query) } : null
        },
        // Pasted text is read as a message is, its lines kept; Shift-paste puts it in as typed.
        readPaste: readAgentPaste,
      }),
      ChatCommandMenu.configure({ store: commandStore, commands: () => latest.current.commands ?? [] }),
      ChatComposerKeys.configure({
        submit: () => actions.current.submit(false),
        escape: () => actions.current.escape(),
      }),
    ],
    content: chat.parse(options.value),
    // The paste reader above has read any markdown in pasted text. Paste rules
    // would read the text it left again, bolding a Shift-pasted `__init__`.
    enablePasteRules: false,
    editorProps: {
      attributes: { class: cn(MARKDOWN_EDITOR_CONTENT_CLASS, COMPOSER_CONTENT_CLASS) },
      // A picture pasted or dropped is an attachment or nothing; anything else is text.
      handlePaste: (view, event) => {
        const data = event.clipboardData
        const files = filesFrom(data)
        if (files.length > 0) {
          if (takeFiles(files)) {
            return true
          }
          // The files refused, the paste's plain text is pasted as any pasted
          // text is, and its HTML is not: office apps copy a picture of the
          // copied cells or text beside the text, and the HTML can name it.
          const text = data?.getData('text/plain')
          if (text) {
            insertPaste(view, readAgentPaste(text, plainPaste(view)))
          }
          return true
        }
        const text = plainPaste(view) ? null : preformattedText(data)
        if (text === null) {
          return false
        }
        insertPaste(view, readAgentPaste(text, false))
        return true
      },
      handleDrop: (_view, event) => {
        const files = filesFrom(event.dataTransfer)
        if (files.length === 0) {
          return false
        }
        takeFiles(files)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = readMarkdown(editor, 'agent')
      if (markdown !== known.current) {
        report(markdown)
      }
    },
    onFocus: () => latest.current.onFocus?.(),
    onBlur: () => latest.current.onBlur?.(),
  })

  // A load from the host. The revision is the signal: the value alone can't
  // tell "load this text again" from an echo of what was typed.
  const loadedRevision = useRef(options.valueRevision)
  useLayoutEffect(() => {
    if (!editor || options.valueRevision === loadedRevision.current) {
      return
    }
    loadedRevision.current = options.valueRevision
    known.current = options.value
    setText(options.value)
    load(editor, options.value)
  }, [editor, options.valueRevision, options.value])

  // The field that stands in before the editor, and whether it holds the
  // focus; the editor takes over its text and its focus as it arrives, so a
  // keystroke made while the composer loads is never lost. The node is kept
  // rather than read through a ref, which is cleared as the field goes, and
  // the focus is noted as React attaches to it too: on a server-rendered page
  // the reader may have typed into it, focus and all, before hydration.
  const early = useRef<{ node: HTMLTextAreaElement | null; focused: boolean }>({ node: null, focused: false })
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the editor arrives; `report` is a new closure every render and reads only refs and the latest options
  useLayoutEffect(() => {
    if (!editor) {
      return
    }
    const { node, focused } = early.current
    early.current = { node: null, focused: false }
    // Only text the reader typed: a field nobody typed into still holds the
    // text it was given, which the editor has had from the start or from a
    // load since.
    if (node && node.value !== node.defaultValue) {
      editor.commands.setContent(typedDoc(node.value))
      report(readMarkdown(editor, 'agent'))
    }
    if (focused) {
      editor.commands.focus('end')
    }
  }, [editor])

  // A focus asked for before the editor was there is given once it is.
  const pendingFocus = useRef<'here' | 'end' | null>(null)
  useEffect(() => {
    if (editor && pendingFocus.current) {
      editor.commands.focus(pendingFocus.current === 'end' ? 'end' : undefined)
      pendingFocus.current = null
    }
  }, [editor])
  useImperativeHandle(
    options.inputRef,
    () => ({
      focus: () => (editor ? editor.commands.focus() : (pendingFocus.current = 'here')),
      focusEnd: () => (editor ? editor.commands.focus('end') : (pendingFocus.current = 'end')),
    }),
    [editor],
  )

  const commandState = useSyncExternalStore(commandStore.subscribe, commandStore.get, () => null)
  const mentionState = useSyncExternalStore(mentionStore.subscribe, mentionStore.get, () => null)
  const suggestions: AgentCommandBarSuggestions | null =
    commandState && commandState.items.length > 0
      ? {
          kind: 'commands',
          items: commandState.items,
          activeIndex: commandState.activeIndex,
          onSelect: commandState.choose,
          onHover: (activeIndex) => commandStore.set({ ...commandState, activeIndex }),
        }
      : mentionState && mentionState.items.length > 0
        ? {
            kind: 'mentions',
            items: mentionState.items,
            activeIndex: mentionState.activeIndex,
            onSelect: mentionState.choose,
            onHover: (activeIndex) => mentionStore.set({ ...mentionState, activeIndex }),
          }
        : null

  const input = editor ? (
    <>
      <FieldMenus editor={editor} className={COMPOSER_FIELD_CLASS}>
        <EditorContent editor={editor} className='max-h-60 min-h-0 flex-1 overflow-y-auto' />
      </FieldMenus>
      <LinkPopover editor={editor} />
      <HintPopover editor={editor} />
    </>
  ) : (
    // Until the editor is there -- server-rendered, and for the moment after
    // mount before it is created -- a plain field in the same box takes the
    // focus and whatever is typed, and the editor takes both over.
    <textarea
      ref={(node) => {
        if (node) {
          early.current = { node, focused: early.current.focused || document.activeElement === node }
        }
      }}
      rows={1}
      defaultValue={options.value}
      placeholder={options.placeholder}
      autoFocus={options.autoFocus}
      onFocus={() => {
        early.current.focused = true
      }}
      onBlur={() => {
        early.current.focused = false
      }}
      className={cn(
        COMPOSER_FIELD_CLASS,
        COMPOSER_CONTENT_CLASS,
        'w-full resize-none border-0 bg-transparent outline-none placeholder:text-muted-foreground',
      )}
    />
  )

  return { input, hasText: Boolean(text.trim()), submit, suggestions }
}

export type ChatCommandBarProps = ChatComposerOptions & Omit<AgentCommandBarProps, 'composer'>

/**
 * The command bar with the chat composer in it. Typing re-renders this
 * component and nothing above it, so a host can hold the element and publish
 * it into a slot elsewhere without rebuilding it on every keystroke.
 */
export function ChatCommandBar({
  value,
  valueRevision,
  onValueChange,
  onSend,
  onEscape,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  commands,
  mentions,
  inputRef,
  ...bar
}: ChatCommandBarProps) {
  const composer = useChatComposer({
    value,
    valueRevision,
    onValueChange,
    onSend,
    onEscape,
    placeholder,
    autoFocus,
    onFocus,
    onBlur,
    sending: bar.sending,
    disabled: bar.disabled,
    commands,
    mentions,
    onFiles: bar.onFiles,
    inputRef,
  })
  return <AgentCommandBar composer={composer} {...bar} />
}
