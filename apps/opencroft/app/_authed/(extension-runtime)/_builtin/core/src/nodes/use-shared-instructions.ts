import { invoke } from '@opencroft/client/actions'
import { useCallback, useEffect, useRef, useState } from 'react'

import { type SharedText, SharedTextSaver, type SharedWriteAnswer } from './shared-instructions-saver'

// How long typing pauses before the text is saved.
const SAVE_DELAY_MS = 800

/**
 * The shared text of one place in the editor, saved a moment after each edit
 * to that place at the version it was read at (see SharedTextSaver for the
 * conflict rules). A save still waiting when the editor goes away is made at
 * once; the server refuses it if the agent has moved to another place since.
 */
export function useSharedInstructions(nodeId: string, place: string, read: SharedText) {
  const [saver] = useState(
    () =>
      new SharedTextSaver(
        read,
        (text, version) => invoke<SharedWriteAnswer>('agent.writeSharedInstructions', nodeId, text, { place, version }),
        (next) => setState(next),
      ),
  )
  const [state, setState] = useState(saver.current)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    saver.adoptRead(read)
  }, [saver, read])

  const onChange = useCallback(
    (text: string) => {
      saver.edit(text)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        void saver.save()
      }, SAVE_DELAY_MS)
    },
    [saver],
  )

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
        void saver.save()
      }
    },
    [saver],
  )

  const takeTheirs = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    saver.takeTheirs()
  }, [saver])

  const keepMine = useCallback(() => void saver.keepMine(), [saver])

  return { ...state, onChange, takeTheirs, keepMine }
}
