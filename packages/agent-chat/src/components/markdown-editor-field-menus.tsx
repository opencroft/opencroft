'use client'

import { posToDOMRect } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { type Editor, useEditorState } from '@tiptap/react'
import { Blocks, Columns3, Heading, Table2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import {
  SelectionBar,
  type SelectionBarAction,
  type SelectionBarGroup,
  type SelectionBarMenu,
  useSelectionBar,
} from 'ui/components/ui/selection-bar'

import { MarkdownEditorField } from './markdown-editor-frame'
import { MarkdownGridLayoutPreview } from './markdown-grid'
import {
  MARKDOWN_GRID_LAYOUTS,
  type MarkdownGridLayout,
  markdownGridBlockCount,
  markdownGridLayoutLabel,
} from './markdown-grid-layouts'
import { actionStates, EDITOR_ACTIONS, type EditorAction, type EditorActionState } from './markdown-editor-actions'
import { BLOCK_INSERTS } from './markdown-editor-block-inserts'
import { chooseSectionLayout, sectionLayoutAt } from './markdown-editor-sections'
import { runTableCommand, type TableAtCaret, TableCellMenuContext, tableAtCaret } from './markdown-editor-table'
// Imported under their own names: the design kit's preview runtime resolves a
// sibling component's import by its local name, so a renamed one is undefined
// there.
import { ACTIONS, ALIGNS, alignCommand, DELETE_TABLE, type Action as TableAction } from './markdown-table-actions'

/*
 * The field look's menus. A right-click is the browser's own, so its spelling
 * suggestions, Cut, Copy and Paste stay reachable and reach the editor as the
 * keyboard's do. Selected text gets the selection bar instead: the text styles
 * used most, then `⋮` for everything else the toolbar offers but Undo and
 * Redo, and for the table's actions while the selection is in a table.
 *
 * The bar follows the selection however it was made: a mouse drag once the
 * button is released, the keyboard, or a finger. On a touch screen every
 * gesture stays the platform's, so one finger still selects text, moves the
 * handles and scrolls the field, and the platform's own selection menu opens
 * as usual; the bar keeps out of that menu's way and out of the handles', and
 * waits until the selection has settled.
 */

/**
 * The on-screen keyboard closes, the visible viewport growing back by at
 * least this much at the same width. Keyboards are well over 200px tall; the
 * browser's own toolbar, which also comes and goes as the page scrolls, is
 * about 56px.
 */
const KEYBOARD_CLOSED_GROWTH = 120

/**
 * On a touch screen, the text gives up focus when the on-screen keyboard
 * closes while it has focus: a tap elsewhere, or the platform's back gesture.
 * A field left focused without its keyboard takes no typing yet looks ready
 * for it, and the next tap in it would not bring the keyboard back.
 */
function useBlurWhenKeyboardCloses(editor: Editor, touch: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!touch || !viewport) {
      return
    }
    let { width, height } = viewport
    const onResize = () => {
      const closed = viewport.width === width && viewport.height - height >= KEYBOARD_CLOSED_GROWTH
      width = viewport.width
      height = viewport.height
      if (closed && !editor.isDestroyed && editor.isFocused) {
        editor.commands.blur()
      }
    }
    viewport.addEventListener('resize', onResize)
    return () => viewport.removeEventListener('resize', onResize)
  }, [editor, touch])
}

interface SelectionRange {
  from: number
  to: number
}

/**
 * Whether the bar is open: `shown`, unless Escape closed it for the selection
 * `from`–`to`. It stays closed until the selection leaves that range. With
 * the bar's list open, Escape closes the list first (`closeList`, returning
 * whether there was one to close), and the next one the bar. The Escape that
 * closes either goes no further, as a popup's does: a host's own Escape
 * (clearing a message, leaving an edit) waits for the next press.
 *
 * It is the first of the editor's key handlers, ahead of every keymap: a host
 * that takes Escape in a keymap of its own would otherwise see it first.
 */
function useEscapeToClose(
  editor: Editor,
  shown: boolean,
  { from, to }: SelectionRange,
  closeList: () => boolean,
): boolean {
  const [dismissed, setDismissed] = useState<SelectionRange | null>(null)
  const open = shown && !(dismissed?.from === from && dismissed.to === to)
  // Escape closes the bar for this selection only: once the selection moves
  // off it, or the bar would close anyway (collapsed, blurred), it is
  // forgotten, so choosing the same text again opens the bar.
  if (dismissed && (!shown || dismissed.from !== from || dismissed.to !== to)) {
    setDismissed(null)
  }
  const openRef = useRef(open)
  const closeListRef = useRef(closeList)
  useEffect(() => {
    openRef.current = open
    closeListRef.current = closeList
  })
  useEffect(() => {
    const key = new PluginKey('markdownEditorSelectionBarEscape')
    const plugin = new Plugin({
      key,
      props: {
        handleKeyDown: (_view, event) => {
          if (event.key !== 'Escape' || !openRef.current) {
            return false
          }
          // Past the editor too: a dialog around it closes on Escape.
          event.stopPropagation()
          if (!closeListRef.current()) {
            const { from, to } = editor.state.selection
            setDismissed({ from, to })
          }
          return true
        },
      },
    })
    editor.registerPlugin(plugin, (added, plugins) => [added, ...plugins])
    return () => {
      if (!editor.isDestroyed) {
        editor.unregisterPlugin(key)
      }
    }
  }, [editor])
  return open
}

const ALL_ACTIONS = Object.values(EDITOR_ACTIONS).flat()

/** The bar's own buttons: the text styles used most, Link, and Clear formatting. */
const QUICK_ACTION_IDS = ['bold', 'italic', 'code', 'link', 'clear']
const QUICK_ACTIONS = QUICK_ACTION_IDS.map((id) => {
  const action = ALL_ACTIONS.find((each) => each.id === id)
  if (!action) {
    throw new Error(`No editor action "${id}"`)
  }
  return action
})

/** Runs of the grid's layouts, one per block count. */
const LAYOUT_RUNS: MarkdownGridLayout[][] = []
for (const layout of MARKDOWN_GRID_LAYOUTS) {
  const run = LAYOUT_RUNS.at(-1)
  if (run && markdownGridBlockCount(run[0]) === markdownGridBlockCount(layout)) {
    run.push(layout)
  } else {
    LAYOUT_RUNS.push([layout])
  }
}

/** Runs of `BLOCK_INSERTS`, one per group, in its order. */
const INSERT_RUNS = BLOCK_INSERTS.reduce<(typeof BLOCK_INSERTS)[number][][]>((runs, item) => {
  const run = runs.at(-1)
  if (run && run[0].group === item.group) {
    run.push(item)
  } else {
    runs.push([item])
  }
  return runs
}, [])

/** The box around the selection, as the bar is placed against. */
function selectionAnchor(editor: Editor, from: number, to: number) {
  return {
    contextElement: editor.view.dom,
    getBoundingClientRect: () => posToDOMRect(editor.view, from, to),
  }
}

/** An editor action as a row of the menu or a button of the bar, with its state for the selection. */
function menuAction(
  editor: Editor,
  states: Record<string, EditorActionState>,
  action: EditorAction,
): SelectionBarAction {
  return {
    id: action.id,
    label: action.label,
    icon: action.icon,
    checked: action.active ? states[action.id]?.active : undefined,
    disabled: states[action.id] ? !states[action.id].enabled : false,
    onSelect: () => action.run(editor),
  }
}

/**
 * The table's actions for the caret's cell, as the cell's own menu offers
 * them: its row's, its column's with the column's alignment, and Delete table.
 */
function tableMenu(editor: Editor, table: TableAtCaret): SelectionBarGroup {
  const item = (action: TableAction, index: number, count: number): SelectionBarAction => {
    const command = action.command(index, count)
    return {
      id: action.label,
      label: action.label,
      icon: action.icon,
      destructive: action.destructive,
      disabled: !command,
      onSelect: () => command && runTableCommand(editor, table.pos, command),
    }
  }
  const { row, column } = table.cell
  return {
    id: 'table',
    label: 'Table',
    icon: Table2,
    runs: [
      ...ACTIONS.row.map((run) => run.map((action) => item(action, row, table.rows))),
      ...ACTIONS.column.map((run) => run.map((action) => item(action, column, table.columns))),
      ALIGNS.map((option) => ({
        id: option.align,
        label: option.label,
        icon: option.icon,
        checked: (table.align ?? 'left') === option.align,
        onSelect: () => runTableCommand(editor, table.pos, alignCommand(column, option.align)),
      })),
      [item(DELETE_TABLE, 0, 1)],
    ],
  }
}

/** Whether an action is not one of the bar's own buttons, which `⋮` never repeats. */
const notOnTheBar = (action: EditorAction) => !QUICK_ACTION_IDS.includes(action.id)

/**
 * What the bar's `⋮` lists: what the bar's own buttons don't do. The other
 * text styles with the block styles (lists, quote, code block, rule) right
 * after them, then the link and hint actions, all as they are; then the
 * toolbar's other groups, and the table's while the selection is in one. Undo
 * and Redo stay on the keyboard: a menu round-trip per step is slower than the
 * shortcut.
 */
export function fullMenu(
  editor: Editor,
  states: Record<string, EditorActionState>,
  section: MarkdownGridLayout | undefined,
  table: TableAtCaret | null,
): SelectionBarMenu {
  const item = (action: EditorAction) => menuAction(editor, states, action)
  return [
    [...EDITOR_ACTIONS.marks, ...EDITOR_ACTIONS.blocks, ...EDITOR_ACTIONS.links].filter(notOnTheBar).map(item),
    [{ id: 'headings', label: 'Headings', icon: Heading, runs: [EDITOR_ACTIONS.headings.map(item)] }],
    [
      {
        id: 'sections',
        label: 'Sections',
        icon: Columns3,
        runs: LAYOUT_RUNS.map((run) =>
          run.map((layout) => ({
            id: layout,
            label: markdownGridLayoutLabel(layout),
            preview: <MarkdownGridLayoutPreview layout={layout} className='h-4 w-20' />,
            checked: section === layout,
            onSelect: () => chooseSectionLayout(editor, layout),
          })),
        ),
      },
      {
        id: 'insert',
        label: 'Insert',
        icon: Blocks,
        runs: INSERT_RUNS.map((run) =>
          run.map((insert) => ({
            id: insert.id,
            label: insert.label,
            icon: insert.icon,
            onSelect: () => insert.insert(editor.chain().focus()).run(),
          })),
        ),
      },
    ],
    table ? [tableMenu(editor, table)] : [],
  ]
}

/** The editable text in the field look, with its selection bar. */
export function FieldMenus({ editor, className, children }: { editor: Editor; className?: string; children: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      actions: actionStates(editor, ALL_ACTIONS),
      section: sectionLayoutAt(editor.state),
      table: tableAtCaret(editor.state),
      focused: editor.isFocused,
      editable: editor.isEditable,
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }),
  })
  // Nothing in the bar takes focus, so the text has it all the while the bar
  // is in use. Typing over the selection collapses it, which closes the bar.
  const selected = state.from !== state.to && state.focused && state.editable
  const bar = useSelectionBar({
    selection: selected ? `${state.from}-${state.to}` : null,
    pressTarget: editor.view.dom,
  })
  const open = useEscapeToClose(editor, bar.open, state, () => {
    if (!moreOpen) {
      return false
    }
    setMoreOpen(false)
    return true
  })
  // The list belongs to the bar it was opened from.
  if (!open && moreOpen) {
    setMoreOpen(false)
  }
  useBlurWhenKeyboardCloses(editor, bar.touch)
  // A new box for each selection, so the bar moves with it.
  const anchor = useMemo(() => selectionAnchor(editor, state.from, state.to), [editor, state.from, state.to])

  return (
    <>
      <MarkdownEditorField className={className}>
        <TableCellMenuContext value={false}>{children}</TableCellMenuContext>
      </MarkdownEditorField>
      <SelectionBar
        open={open}
        anchor={anchor}
        actions={QUICK_ACTIONS.map((action) => menuAction(editor, state.actions, action))}
        more={fullMenu(editor, state.actions, state.section, state.table)}
        touch={bar.touch}
        moreOpen={moreOpen}
        onMoreOpenChange={setMoreOpen}
      />
    </>
  )
}
