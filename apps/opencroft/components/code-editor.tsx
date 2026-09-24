'use client'

import { type DiffOnMount, Editor, loader, DiffEditor as MonacoDiffEditor, type OnMount } from '@monaco-editor/react'
import { Columns2, Rows2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from 'ui/button'

import { cn } from '@/lib/utils'

// The host's single code editor, shared with extensions through the extension
// UI surface (`legacy.CodeEditor`) rather than imported by each extension.
//
// That sharing is not a convenience, it is the correctness requirement. An
// extension's client bundle is a browser ESM bundle with no runtime module
// resolver, so an extension that imported an editor package would get its own
// copy of @monaco-editor/loader. Two loader instances each hold their own
// "initialized" flag and only adopt an existing editor when `window.monaco` is
// already set — so two of them mounting before the first finishes injects the
// AMD loader script twice and races on `window.require`. The compiler already
// redirects `react` to the host's copy for the same class of reason; Monaco
// belongs on the same footing.
//
// The same argument is why diffs are a mode of this component rather than a
// second one: a diff is the same editor runtime with a second model, and every
// surface that shows one should reach it through here.
//
// Monaco's runtime comes from this app's own build rather than from the public
// CDN @monaco-editor/loader defaults to. ./monaco-runtime is what decides that:
// it calls `loader.config({ monaco })` with the namespace imported from the npm
// package, so the version in the lockfile is the version that runs.
// Still re-exported, because this stays the one place that owns that decision
// and a caller may need the handle — but note that configuring it again after
// the first editor has mounted does nothing, since `init()` is one-shot.
export { loader }

// Monaco's runtime is behind one dynamic import, and this is the only one.
//
// Static would be wrong twice over. This module is in the static graph of
// surfaces that merely MIGHT show code — the chat transcript's tool views, the
// extension host's UI surface — so `import * as monaco from 'monaco-editor'`
// here would put the whole editor on the first load of a page whose reader
// never opens one. And the extension compiler imports the host surface under
// bare `tsx` to read what the host offers: Monaco's ESM imports stylesheets, and
// a runtime with no CSS loader cannot follow that edge at all. Both are pinned
// by host-import-graph.test.ts, which walks static imports only.
//
// The module configures the loader at its own module scope, so once this promise
// resolves `loader.config({ monaco })` has already run and an editor may mount:
// @monaco-editor/react calls `loader.init()` from its mount effect, and `init()`
// with an instance already configured resolves with it immediately and injects
// no script. Config after that point is silently ignored, which is why nothing
// below renders an editor until `ready`.
let monacoRuntime: Promise<void> | undefined
let monacoRuntimeLoaded = false

function loadMonacoRuntime(): Promise<void> {
  monacoRuntime ??= import('./monaco-runtime').then(() => {
    monacoRuntimeLoaded = true
  })
  return monacoRuntime
}

// Seeded from the module flag so the second and later editors of a session
// render Monaco on their first render instead of flashing the skeleton again.
// It is false on the server and on the first client render — the import runs in
// an effect, which the server never reaches — so hydration stays in step.
function useMonacoRuntime(): boolean {
  const [ready, setReady] = useState(monacoRuntimeLoaded)
  useEffect(() => {
    if (ready) {
      return
    }
    let live = true
    loadMonacoRuntime().then(() => {
      if (live) {
        setReady(true)
      }
    })
    return () => {
      live = false
    }
  }, [ready])
  return ready
}

// Whatever this is, it reaches Monaco verbatim, and Monaco registers around
// forty languages and accepts every one of them at run time. So this union was
// never the set that works — it was a ceiling on the set you were allowed to
// ask for, and the six below are simply the ones the host's own surfaces
// happened to need.
//
// `(string & {})` opens it to the other thirty-odd while keeping the six as
// autocomplete. The alternative — naming all forty — was rejected twice over.
// It would put a copy of Monaco's registry in a file that does not own it, so
// every entry is either a lie until the next Monaco upgrade or a truth nobody
// re-checked. And it buys nothing for the callers that need the width, because
// they compute the language at run time from something that is already a
// string: the git extension maps a file path through `langFromPath`, whose
// return type is `string`, so a closed union would meet it with a cast at
// every call site and throw away the only thing a closed union is for.
export type CodeEditorLanguage = 'typescript' | 'javascript' | 'python' | 'shell' | 'json' | 'plaintext' | (string & {})

// Re-exported so a caller needs one import for the editor and the thing that
// tells it what language to use, while the table itself stays in a module that
// can be loaded — and tested — without pulling Monaco in behind it.
export { languageFromPath } from './code-language'

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
 * (`new monaco.Range(...)` for a decoration, say), and an extension bundle has
 * no runtime module resolver, so importing `monaco-editor` for it is not open
 * to one. Receiving it here is what lets a caller install the `window.monaco`
 * shim it would otherwise have no way to obtain.
 */
export type CodeEditorOnMount = (
  editor: Parameters<OnMount>[0] | Parameters<DiffOnMount>[0],
  monaco: Parameters<OnMount>[1],
) => void

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
   * diff mode it instead defaults to the content's own height, bounded (see
   * MIN_HEIGHT / MAX_HEIGHT), because diffs render inline in a chat transcript.
   */
  height?: string | number
  /**
   * The escape hatch out of this component's props and into Monaco itself, for
   * the things no prop here can express: decorations, diff-change enumeration,
   * mouse and cursor and scroll subscriptions, pixel positions for an overlay.
   * Without it, a surface that needs any of those has to mount its own editor,
   * which is the one thing this component exists to prevent.
   *
   * See `CodeEditorOnMount` for which editor arrives and how to tell.
   */
  onMount?: CodeEditorOnMount
  /**
   * Which diff rendering to show. Omitted, the mode is this component's own
   * state and its overlaid toggle drives it; given, the caller owns it and
   * this becomes an ordinary controlled prop.
   *
   * For a surface whose diff mode is not the reader's private business but
   * part of a larger state — one already persisted, shared across several
   * diffs at once, or driven from a toolbar that belongs to the caller.
   */
  diffMode?: CodeEditorDiffMode
  /**
   * Fired when this component's own toggle is pressed. The way to keep that
   * toggle working while `diffMode` is controlled — without it a controlled
   * caller's toggle renders and does nothing, since the state it writes is not
   * the state being displayed.
   */
  onDiffModeChange?: (mode: CodeEditorDiffMode) => void
  /**
   * Draw the overlaid unified/split toggle. Defaults to true.
   *
   * Set false by a caller that already has this control in its own toolbar —
   * otherwise `diffMode` gets it a second toggle sitting on top of the diff,
   * competing with the one it drew itself.
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

export function CodeEditor({ original, ...props }: CodeEditorProps) {
  const ready = useMonacoRuntime()

  // The skeleton is the one @monaco-editor/react's own `loading` prop shows
  // below, hoisted a level: the wait it covers is now the runtime's download
  // rather than the editor's mount, and it has to be drawn by something that
  // is not itself Monaco.
  let body: ReactNode
  if (!ready) {
    body = (
      <div
        className={cn('w-full animate-pulse bg-muted', original === undefined ? 'h-full' : 'h-14 rounded-md border')}
      />
    )
  } else if (original === undefined) {
    body = <PlainEditor {...props} />
  } else {
    body = <DiffView {...props} original={original} />
  }

  return (
    // `nokey` is @xyflow/react's opt-out: its `useKeyPress` calls
    // `preventDefault()` on any key it watches unless the event came from an
    // "interactive element", and `isInputDOMNode` only recognises INPUT /
    // SELECT / TEXTAREA, `contenteditable`, or a `.nokey` ancestor.
    //
    // Monaco defaults `editContext: true`, so it takes input through the
    // EditContext API on a plain div — none of those. Without this class the
    // canvas swallows Space (its pan-activation key) so it never reaches the
    // editor, and Backspace/Delete reach the canvas as node deletion while the
    // caret is in the editor. The previous CodeMirror editor was a
    // contenteditable div, which is why neither happened before.
    //
    // Diff mode is `relative` for the overlaid mode toggle, and `min-w-0
    // max-w-full` guard the cases where this box is a flex item or has a
    // definite containing block.
    <div className={cn('nokey', original === undefined ? 'h-full w-full' : 'relative min-w-0 max-w-full')}>{body}</div>
  )
}

function PlainEditor({
  value,
  language = 'typescript',
  readOnly,
  onChange,
  line,
  height = '100%',
  onMount,
}: Omit<CodeEditorProps, 'original'>) {
  const { resolvedTheme } = useTheme()

  // `line` is applied before the caller's hook runs, so a caller that moves the
  // cursor itself moves it from the resting position rather than racing it.
  const handleMount: OnMount = (editor, monaco) => {
    if (line) {
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
    }
    onMount?.(editor, monaco)
  }

  return (
    <Editor
      height={height}
      language={language}
      value={value}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
      onChange={onChange ? (next) => onChange(next ?? '') : undefined}
      onMount={handleMount}
      loading={<div className='h-full w-full animate-pulse bg-muted' />}
      options={{
        readOnly: Boolean(readOnly) || !onChange,
        // `readOnly` alone still takes focus and shows a caret, which reads as
        // an editable field that silently drops input.
        domReadOnly: Boolean(readOnly) || !onChange,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        folding: true,
        tabSize: 2,
        contextmenu: false,
        fontSize: 12,
        // Containers here are sized by the surrounding layout (inspector tabs,
        // resizable panels) and change without a React render, so Monaco has to
        // observe its box rather than be told about it.
        automaticLayout: true,
      }}
    />
  )
}

/** Which of the two renderings of the same pair of documents is on screen. */
export type CodeEditorDiffMode = 'unified' | 'split'

// Diffs render inline in a chat transcript, so the editor is sized to its
// content rather than given a fixed box. The floor keeps a one-line diff from
// collapsing under its own toolbar; the ceiling stops a thousand-line diff from
// swallowing the transcript, and hands the rest to Monaco's own scroller.
// (Carried over from the chat package's diff editor, which these diffs used to
// be rendered by; a caller that wants a fixed box passes `height`.)
const MIN_HEIGHT = 56
const MAX_HEIGHT = 400

function ModeToggle({ mode, onChange }: { mode: CodeEditorDiffMode; onChange: (mode: CodeEditorDiffMode) => void }) {
  return (
    <div className='flex gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur-sm'>
      <Button
        variant='ghost'
        size='icon'
        className={cn('h-6 w-6', mode === 'unified' && 'bg-accent')}
        onClick={() => onChange('unified')}
        title='Unified'
      >
        <Rows2 className='h-3 w-3' />
      </Button>
      <Button
        variant='ghost'
        size='icon'
        className={cn('h-6 w-6', mode === 'split' && 'bg-accent')}
        onClick={() => onChange('split')}
        title='Side by side'
      >
        <Columns2 className='h-3 w-3' />
      </Button>
    </div>
  )
}

// The folding this component has always applied. Named so the merge below has
// something to merge over, and so a caller passing one field keeps the rest.
const HIDE_UNCHANGED_DEFAULT: CodeEditorHideUnchangedRegions = {
  enabled: true,
  minimumLineCount: 4,
  contextLineCount: 3,
}

function DiffView({
  value,
  original,
  language = 'typescript',
  readOnly,
  onChange,
  line,
  height,
  onMount,
  diffMode,
  onDiffModeChange,
  showModeToggle = true,
  hideUnchangedRegions,
}: Omit<CodeEditorProps, 'original'> & { original: string }) {
  // The chat package's diff editor tracked dark mode itself, watching <html>
  // for the `dark` class with a MutationObserver — it has to, being usable by
  // any host regardless of how that host switches themes. Here we are the host:
  // `next-themes` is the signal the rest of the app already reads, it is
  // mounted above every mount of this component, and it costs no observer per
  // visible diff. Same rule as the ordinary editor above, so the two modes
  // cannot disagree about the theme.
  const { resolvedTheme } = useTheme()

  // Unified by default. Side by side splits an already narrow column in two and
  // is unreadable on a phone even when it fits; the toggle keeps it one press
  // away. Deliberately unconditional rather than chosen from the viewport — a
  // default that flips under a resize is state to reason about, and nothing
  // here needs it.
  //
  // Held here only while no caller claims it. The usual case is still that
  // which of two renderings of one pair of documents you are looking at is the
  // reader's business and nobody else's — but a surface where the choice
  // belongs to a toolbar of its own, spans several diffs, or outlives this
  // mount does have an opinion, and `diffMode` is how it states it.
  const [ownMode, setOwnMode] = useState<CodeEditorDiffMode>('unified')
  const mode = diffMode ?? ownMode
  const setMode = useCallback(
    (next: CodeEditorDiffMode) => {
      // Skipped while controlled, so the value on screen has exactly one
      // owner: writing both would leave a stale copy here to be shown again
      // the moment the prop went away.
      if (diffMode === undefined) {
        setOwnMode(next)
      }
      onDiffModeChange?.(next)
    },
    [diffMode, onDiffModeChange],
  )
  const [contentHeight, setContentHeight] = useState(MIN_HEIGHT)

  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null)
  const disposablesRef = useRef<{ dispose: () => void }[]>([])
  // Read through a ref so the content-size subscriptions below stay valid
  // across a mode change. Switching mode only updates Monaco's options, it
  // doesn't remount the editor, so a listener that closed over `mode` would go
  // on measuring for the mode it was registered in. (Kept in step by the effect
  // below rather than during render, so that the re-measure it has to do anyway
  // is the same piece of work.)
  const modeRef = useRef<CodeEditorDiffMode>(mode)
  // Same reason, for the change subscription: it is registered once on mount
  // and must see the current props, not the ones it was created with.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // And the same again for the caller's mount hook, so an inline arrow — which
  // is a new function on every render — does not rebuild `handleMount` and the
  // subscriptions memoised alongside it.
  const onMountRef = useRef(onMount)
  onMountRef.current = onMount
  const valueRef = useRef(value)
  valueRef.current = value

  const syncHeight = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    const modified = editor.getModifiedEditor().getContentHeight()
    // Side by side is as tall as its taller pane. Inline renders the removed
    // lines inside the modified editor as view zones, so that one already
    // accounts for both sides and taking the max would overshoot.
    const tallest =
      modeRef.current === 'split' ? Math.max(modified, editor.getOriginalEditor().getContentHeight()) : modified
    setContentHeight(Math.min(Math.max(tallest, MIN_HEIGHT), MAX_HEIGHT))
  }, [])

  const handleMount = useCallback<DiffOnMount>(
    (editor, monaco) => {
      editorRef.current = editor
      const modified = editor.getModifiedEditor()
      disposablesRef.current = [
        editor.getOriginalEditor().onDidContentSizeChange(syncHeight),
        modified.onDidContentSizeChange(syncHeight),
        // `DiffEditor` has no `onChange` prop of its own — the modified model is
        // the only editable half, so the edit event comes off that editor.
        modified.onDidChangeModelContent(() => {
          const next = modified.getValue()
          // A new `value` prop is applied by writing the model, which lands here
          // too; skipping it keeps a controlled caller from being handed back
          // the write it just made.
          if (next !== valueRef.current) {
            onChangeRef.current?.(next)
          }
        }),
      ]
      if (line) {
        modified.revealLineInCenter(line)
        modified.setPosition({ lineNumber: line, column: 1 })
      }
      syncHeight()
      // Last, and after the height is settled: a caller that measures the
      // editor from here — for an overlay placed against `getTopForLineNumber`
      // and `getLayoutInfo` — would otherwise be reading a box about to change.
      onMountRef.current?.(editor, monaco)
    },
    [syncHeight, line],
  )

  // Point the listeners at the new mode and re-measure: the two layouts have
  // different heights for the same pair of documents, and toggling doesn't
  // itself change content size, so nothing else would reliably fire.
  useEffect(() => {
    modeRef.current = mode
    syncHeight()
  }, [syncHeight, mode])

  useEffect(
    () => () => {
      for (const disposable of disposablesRef.current) {
        disposable.dispose()
      }
      disposablesRef.current = []
      // @monaco-editor/react 4.7 disposes the models before the editor that
      // still shows them, which Monaco 0.55 answers with "TextModel got disposed
      // before DiffEditorWidget model got reset". So the models are kept out of
      // its hands (`keepCurrent*Model` below) and released here instead —
      // detached first. This runs before the library's own unmount cleanup,
      // since React runs a parent's cleanups before its children's.
      const editor = editorRef.current
      const models = editor?.getModel()
      editor?.setModel(null)
      models?.original.dispose()
      models?.modified.dispose()
      editorRef.current = null
    },
    [],
  )

  return (
    <>
      {/* Overlaid on top of the diff instead of its own row, so it doesn't cost
          a whole line of vertical space — which is also why it has to be
          suppressible: a caller with its own toggle cannot move this one out of
          the way, only end up with two of them stacked over the same diff. */}
      {showModeToggle && (
        <div className='absolute right-2 top-2 z-10'>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      )}
      {/* `contain: inline-size` makes this box's width computable without
          looking at its contents, so a long line can't propagate outward
          through every ancestor whose width is content-derived and widen the
          whole page — the failure this fixed, measured at 1060px of content
          inside a 360px column on a phone.

          Monaco lays out absolutely inside a box it is told the size of, so it
          is far less likely than the previous CodeMirror implementation to
          inflate an ancestor on its own. The containment is kept anyway: it
          costs nothing, and dropping it would be an unforced bet that the new
          editor never does. Under it this box contributes nothing to intrinsic
          sizing, so it needs a containing block with a definite width — every
          call site gives it one, and a host that doesn't will collapse it to
          zero. */}
      <div className='w-full min-w-0 [contain:inline-size] overflow-hidden rounded-md border'>
        <MonacoDiffEditor
          height={height ?? contentHeight}
          language={language}
          original={original}
          modified={value}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
          onMount={handleMount}
          loading={<div className='h-14 w-full animate-pulse bg-muted' />}
          options={{
            // The modified side follows the same rule as the ordinary editor:
            // no `onChange` means nothing could accept an edit anyway.
            readOnly: Boolean(readOnly) || !onChange,
            // Unlike the ordinary editor this does not also set `domReadOnly`:
            // a diff is read to be read, and taking the element out of the
            // input path would take selection and copy out with it.
            originalEditable: false,
            renderSideBySide: mode === 'split',
            // Monaco traps the wheel by default, which inside a chat transcript
            // means scrolling stalls whenever the pointer crosses a diff.
            scrollbar: { alwaysConsumeMouseWheel: false },
            // Long diffs are mostly untouched context; collapse it the way the
            // previous implementation's `collapseUnchanged` did. Merged rather
            // than replaced so a caller adjusting one number is not made to
            // restate defaults it has no opinion about; `false` is the
            // shorthand for the whole file, since that is the thing a caller
            // actually asks for and `{ enabled: false }` is how Monaco spells
            // it rather than how anyone means it.
            hideUnchangedRegions:
              hideUnchangedRegions === false
                ? { enabled: false }
                : { ...HIDE_UNCHANGED_DEFAULT, ...hideUnchangedRegions },
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            folding: false,
            contextmenu: false,
            fontSize: 12,
            // The container's width is set by the surrounding layout and changes
            // without a React render (sidebar, rotation), so Monaco has to
            // observe it rather than be told.
            automaticLayout: true,
          }}
        />
      </div>
    </>
  )
}
