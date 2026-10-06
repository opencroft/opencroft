'use client'

import type { MarkdownEditorOwnDocument, MarkdownEditorSurfaceProps } from 'agent-chat/markdown-editor'
import { cn } from 'cn'
import { lazy, type ReactNode, Suspense } from 'react'

export type { MarkdownEditorToolbarGroup } from 'agent-chat/markdown-editor'

/** A document several people edit at once, by the name its owner hands out. */
export interface MarkdownEditorSharedDocument {
  collab: { document: string }
  value?: never
  onChange?: never
}

export type MarkdownEditorProps = MarkdownEditorSurfaceProps &
  (Omit<MarkdownEditorOwnDocument, 'collaboration'> | MarkdownEditorSharedDocument)

/*
 * The markdown WYSIWYG, deferred.
 *
 * The component itself lives in `agent-chat/markdown-editor` and
 * this adds nothing to it but a load boundary. That boundary is the point: the
 * module behind it pulls TipTap and ProseMirror, and this file is reachable
 * from the extension host surface, which is what every surface that merely
 * MIGHT show an extension asks. Imported statically, a canvas that never edits
 * anything would download an editor.
 *
 * Same shape as `./code-editor` and Monaco, and asserted the same way: a test
 * in `(extension-runtime)/_client/host-import-graph.test.ts` walks the host's
 * static imports and fails if the editor module is among them, with the
 * presence of this wrapper asserted beside it so that deleting the feature
 * cannot pass for deferring it.
 *
 * The type imports above are type-only, so they are erased and are not edges.
 * A shared document's editor is behind the same boundary, with Yjs and the
 * collaboration provider besides.
 */
const Editor = lazy(() => import('agent-chat/markdown-editor').then((module) => ({ default: module.MarkdownEditor })))
const SharedEditor = lazy(() =>
  import('@/components/shared-markdown-editor/shared-markdown-editor').then((module) => ({
    default: module.SharedMarkdownEditor,
  })),
)

export function MarkdownEditor(props: MarkdownEditorProps) {
  let editor: ReactNode
  if (props.collab) {
    const { collab, value: _value, onChange: _onChange, ...surface } = props
    editor = <SharedEditor {...surface} document={collab.document} />
  } else {
    const { collab: _collab, ...own } = props
    editor = <Editor {...own} />
  }
  return (
    // The same empty box the editor itself shows before TipTap has created it,
    // so arriving is one transition rather than two.
    <Suspense fallback={<div className={cn('rounded-md border bg-background', props.className)} />}>{editor}</Suspense>
  )
}
