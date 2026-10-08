'use client'

import { NodeViewContent, type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'

import { CodeFrame } from './components/code-block'
import { CODE_PRE_CLASS, fenceLanguage } from './components/code-highlight'
import { MarkdownCodeBlock } from './markdown-editor-schema'

/*
 * A code block as the editor draws it: in the frame `CodeBlock` renders in,
 * headed by its fence's language, so a block looks the same being written as
 * being read. The code is the node's own editable text, coloured by the
 * editor's highlight decorations.
 *
 * `NodeViewContent` writes an inline `white-space: pre-wrap` on itself, which
 * no stylesheet rule outranks; inheriting instead keeps the `pre`'s `pre`, so
 * a long line scrolls sideways as it does in the rendered view.
 */

function CodeBlockView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper>
      <CodeFrame label={fenceLanguage(node.attrs.language as string | undefined)}>
        <pre data-code-block='' className={CODE_PRE_CLASS}>
          <NodeViewContent<'code'> as='code' style={{ whiteSpace: 'inherit' }} />
        </pre>
      </CodeFrame>
    </NodeViewWrapper>
  )
}

export const CodeBlockNode = MarkdownCodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView)
  },
})
