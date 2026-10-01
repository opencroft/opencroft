'use client'

import type { ToolViewMode } from 'agent-chat/tool-views'
import { useEffect, useRef, useState } from 'react'

import { useToolViewHost } from './tool-view-host'

// What an edit-shaped call (a file, skill or node property edit) changed, and
// the live state that change is shown against.

export interface TextEdit {
  oldString: string
  newString: string
  replaceAll: boolean
}

// Replace `from` with `to` in `text` — once, or every occurrence when
// replaceAll. `to` is inserted literally: a string replacement would expand
// `$&`, `$$` and the like, which the tools themselves do not.
function substitute(text: string, from: string, to: string, replaceAll: boolean): string {
  return replaceAll ? text.split(from).join(to) : text.replace(from, () => to)
}

function occurrences(text: string, part: string): number {
  return part === '' ? 0 : text.split(part).length - 1
}

// The two sides of an edit, as its diff shows them. `whole` says whether they
// are the whole text the edit acted on, or only the replaced snippet the call
// itself carries.
//
// Before a call runs (`approval`) the live text is its "before", and the edit
// is applied forward — when it would apply: the tools reject an `oldString`
// that is missing, or repeated without replaceAll.
//
// After it ran (`history`) the live text is its "after", and "before" is worked
// back by putting `oldString` in place of `newString`. Only `oldString` is
// unique by contract, so that is trusted only when it is unambiguous:
// `newString` occurs exactly once in the live text, and the text worked back
// holds `oldString` exactly once, as the tool required. Anything else — a
// `newString` that also occurs elsewhere, an edit since overwritten, a
// deletion, a replaceAll (whose replaced occurrences cannot be told apart from
// ones that were already there) — shows the snippet.
export function editSides(
  mode: ToolViewMode,
  live: string | null,
  edit: TextEdit,
): { original: string; value: string; whole: boolean } {
  const { oldString, newString, replaceAll } = edit
  if (live !== null && mode === 'approval') {
    const count = occurrences(live, oldString)
    if (count === 1 || (replaceAll && count > 1)) {
      return { original: live, value: substitute(live, oldString, newString, replaceAll), whole: true }
    }
  }
  if (live !== null && mode === 'history' && !replaceAll && occurrences(live, newString) === 1) {
    const original = substitute(live, newString, oldString, false)
    if (occurrences(original, oldString) === 1) {
      return { original, value: live, whole: true }
    }
  }
  return { original: oldString, value: newString, whole: false }
}

export function textEdit(args: Record<string, unknown>): TextEdit {
  return {
    oldString: (args.oldString as string | undefined) ?? '',
    newString: (args.newString as string | undefined) ?? '',
    replaceAll: Boolean(args.replaceAll),
  }
}

export interface LiveText {
  // null until the read settles, and while nothing is being read.
  text: string | null
  error: string | null
}

// A text read through the host, read again whenever `key` changes. No key, no
// read. `load` is read from a ref, so a caller may pass a fresh closure on
// every render without re-reading.
function useLiveText(key: string | undefined, load: () => Promise<string>): LiveText {
  const loadRef = useRef(load)
  loadRef.current = load
  const [state, setState] = useState<LiveText>({ text: null, error: null })

  useEffect(() => {
    setState({ text: null, error: null })
    if (key === undefined) {
      return
    }
    let cancelled = false
    loadRef
      .current()
      .then((text) => !cancelled && setState({ text, error: null }))
      .catch((err: Error) => !cancelled && setState({ text: null, error: err.message }))
    return () => {
      cancelled = true
    }
  }, [key])

  return state
}

// The current contents of a file on a remote target, read again for every new
// request.
export function useRemoteFile(
  request: { target?: string; space?: string; path?: string } | undefined,
  requestId: string,
): LiveText {
  const { readFile } = useToolViewHost()
  const { target, space, path } = request ?? {}
  const key = target && path ? JSON.stringify([target, space, path, requestId]) : undefined
  return useLiveText(key, () => readFile({ target: target as string, space, path: path as string }))
}

// The current body of a skill ('' when there is none), read again for every
// new request.
export function useSkillBody(name: string | undefined, requestId: string): LiveText {
  const { readSkill } = useToolViewHost()
  return useLiveText(name ? JSON.stringify([name, requestId]) : undefined, () => readSkill(name as string))
}
