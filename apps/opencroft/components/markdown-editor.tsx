'use client'

import type { MarkdownEditorOwnDocument, MarkdownEditorSurfaceProps } from 'agent-chat/components/markdown-editor'
import { MarkdownEditorPlaceholder } from 'agent-chat/components/markdown-editor-frame'
import { lazy, type ReactNode, Suspense } from 'react'

export type { MarkdownEditorToolbarGroup, MarkdownEditorVariant } from 'agent-chat/components/markdown-editor'

/** A document several people edit at once, by the name its owner hands out. */
export interface MarkdownEditorSharedDocument {
  collab: { document: string }
  value?: never
  onChange?: never
  dialect?: never
}

export type MarkdownEditorProps = MarkdownEditorSurfaceProps &
  (Omit<MarkdownEditorOwnDocument, 'collaboration'> | MarkdownEditorSharedDocument)

/*
 * The markdown WYSIWYG, deferred.
 *
 * The component itself lives in `agent-chat/components/markdown-editor` and
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
const Editor = lazy(() =>
  import('agent-chat/components/markdown-editor').then((module) => ({ default: module.MarkdownEditor })),
)
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
  // The same empty frame the editor itself shows before TipTap has created it,
  // so arriving is one transition rather than two.
  const placeholder = (
    <MarkdownEditorPlaceholder
      variant={props.variant}
      className={props.className}
      contentClassName={props.contentClassName}
    />
  )
  return <Suspense fallback={placeholder}>{editor}</Suspense>
}
