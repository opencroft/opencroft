'use client'

import type { MarkdownEditorProps } from 'agent-chat/markdown-editor'
import { cn } from 'cn'
import { lazy, Suspense } from 'react'

export type { MarkdownEditorProps, MarkdownEditorToolbarGroup } from 'agent-chat/markdown-editor'

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
 * The type re-export above is type-only, so it is erased and is not an edge.
 */
const Editor = lazy(() => import('agent-chat/markdown-editor').then((module) => ({ default: module.MarkdownEditor })))

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    // The same empty box the editor itself shows before TipTap has created it,
    // so arriving is one transition rather than two.
    <Suspense fallback={<div className={cn('rounded-md border bg-background', props.className)} />}>
      <Editor {...props} />
    </Suspense>
  )
}
