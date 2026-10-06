import { type CommandProps, Extension } from '@tiptap/core'
import type { Slice } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'

import { MERGE_WINDOW_MS, stepLatest } from '@/lib/undo-latest-step'

function undoManagerOf(state: EditorState): Y.UndoManager | undefined {
  return (yUndoPluginKey.getState(state) as { undoManager: Y.UndoManager } | undefined)?.undoManager
}

/** Whether `slice` holds a block other than a plain paragraph: a heading, list, table, callout, code block... */
function insertsBlock(slice: Slice): boolean {
  let found = false
  slice.content.descendants((node) => {
    found ||= node.isBlock && node.type.name !== 'paragraph'
    return !found
  })
  return found
}

/**
 * Whether `tr` is a change that is a step of its own, whatever came just
 * before or after it: formatting, a paste or drop, inserting or reshaping a
 * block, and moving the caret somewhere else. Typing and deleting text, and
 * Enter, which only splits a paragraph, run on into the step they continue.
 */
function standsAlone(tr: Transaction, before: EditorState): boolean {
  if (tr.getMeta(ySyncPluginKey)) {
    // Brought in from the shared document: not this editor's change.
    return false
  }
  if (!tr.docChanged) {
    return tr.selectionSet && !tr.selection.eq(before.selection)
  }
  const uiEvent = tr.getMeta('uiEvent')
  if (uiEvent === 'paste' || uiEvent === 'drop') {
    return true
  }
  return tr.steps.some(
    (step) =>
      step instanceof AddMarkStep ||
      step instanceof RemoveMarkStep ||
      step instanceof ReplaceAroundStep ||
      (step instanceof ReplaceStep && insertsBlock(step.slice)),
  )
}

const boundaryKey = new PluginKey<boolean>('oneStepUndoBoundary')

/**
 * Undo and redo in a shared document, by the rules a shared graph keeps: the
 * history is this editor's own -- the collaboration binding's undo manager
 * tracks only this editor's changes, never another person's or an agent's --
 * and one Ctrl+Z reverts exactly one step. Typing within a second of itself
 * is one step; formatting, a paste, a block inserted and a caret moved
 * elsewhere each start one. Replaces the binding's own undo and redo commands,
 * so its keys (Mod-z, Mod-y, Shift-Mod-z) and the toolbar run these; list it
 * after the binding.
 */
export const OneStepUndo = Extension.create({
  name: 'oneStepUndo',

  onCreate() {
    const manager = undoManagerOf(this.editor.state)
    if (manager) {
      manager.captureTimeout = MERGE_WINDOW_MS
    }
  },

  addCommands() {
    const step =
      (stack: 'undoStack' | 'redoStack', run: 'undo' | 'redo') =>
      () =>
      ({ tr, state, dispatch }: CommandProps) => {
        // The step is made in the shared document, which brings the editor
        // along; the command's own transaction carries nothing.
        tr.setMeta('preventDispatch', true)
        const manager = undoManagerOf(state)
        if (!manager || manager[stack].length === 0) {
          return false
        }
        if (dispatch) {
          stepLatest(manager[stack], () => manager[run]())
        }
        return true
      }
    return { undo: step('undoStack', 'undo'), redo: step('redoStack', 'redo') }
  },

  addProseMirrorPlugins() {
    // The binding writes a change into the shared document as the view
    // updates, which is where the undo manager records it. So a change that
    // stands alone closes the step before it while the transaction is applied,
    // and its own step once the view has updated -- this plugin's view comes
    // after the binding's.
    return [
      new Plugin<boolean>({
        key: boundaryKey,
        state: {
          init: () => false,
          apply: (tr, _value, before) => standsAlone(tr, before),
        },
        appendTransaction: (transactions, before, after) => {
          if (transactions.some((tr) => tr.docChanged) && boundaryKey.getState(after)) {
            undoManagerOf(before)?.stopCapturing()
          }
          return null
        },
        view: () => ({
          update: (view, previous) => {
            if (view.state !== previous && boundaryKey.getState(view.state)) {
              undoManagerOf(view.state)?.stopCapturing()
            }
          },
        }),
      }),
    ]
  },
})
