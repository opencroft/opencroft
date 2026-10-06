import type * as Y from 'yjs'

type StackItem = Y.UndoManager['undoStack'][number]

/** How long after a change another change of the same kind still joins its undo step: typing is one step. */
export const MERGE_WINDOW_MS = 1_000

/**
 * Reverts or re-applies exactly the latest step on `stack`, the undo or the
 * redo stack of the manager `run` drives.
 *
 * Y.UndoManager keeps popping until a step changes something, so a step that
 * others have wholly overwritten would be skipped and an older one undone by
 * the same keypress. While `run` runs, the older steps are hidden from it: a
 * step with nothing left to change is dropped and reported as not applied,
 * and the next call reaches the step before it.
 *
 * Returns whether the step changed anything.
 */
export function stepLatest(stack: StackItem[], run: () => StackItem | null): boolean {
  const older = stack.splice(0, stack.length - 1)
  try {
    return run() !== null
  } finally {
    stack.unshift(...older)
  }
}
