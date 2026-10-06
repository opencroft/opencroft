// The canvas's undo and redo keys: Ctrl/Cmd+Z undoes, Ctrl+Y and
// Ctrl/Cmd+Shift+Z redo. Only for presses that belong to the canvas (see
// canvas-key-scope.ts), so a text field or code editor keeps its own undo.
// Matched on the physical key, like the clipboard keys, so they work on any
// keyboard layout.

import { isCanvasKeyPress } from '@/app/_authed/(dashboard)/_canvas/canvas-key-scope'

export type UndoKeyAction = 'undo' | 'redo'

export function undoKeyAction(event: KeyboardEvent, canvas: Element): UndoKeyAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !isCanvasKeyPress(event, canvas)) {
    return null
  }
  if (event.code === 'KeyZ') {
    return event.shiftKey ? 'redo' : 'undo'
  }
  if (event.code === 'KeyY' && !event.shiftKey) {
    return 'redo'
  }
  return null
}
