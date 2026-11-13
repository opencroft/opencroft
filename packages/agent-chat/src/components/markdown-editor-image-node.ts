import { Node } from '@tiptap/core'

/*
 * An image in the text, as the editor reads and writes it:
 * `![alt](src "title")`, one inline atom carrying the address, the alt text
 * and the title. The address is kept as written and drawn as an `<img>` with
 * it, the way the rendered page draws it, so a relative address resolves the
 * same in both.
 *
 * A paragraph holding nothing but an image stays a paragraph
 * (`MarkdownParagraph`): the image is inline, and a page's blocks never hold
 * one directly.
 */

export const IMAGE_NODE = 'markdownImage'

interface ImageToken {
  href?: string
  title?: string | null
  text?: string
}

/** Alt text as markdown reads it back: brackets and backslashes escaped. */
function escapeAlt(alt: string): string {
  return alt.replace(/[\\[\]]/g, (c) => `\\${c}`)
}

/** An address as markdown reads it back: in angle brackets when it holds a space, a bracket or a parenthesis. */
function formatDestination(src: string): string {
  return /[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, (c) => `\\${c}`)}>` : src
}

/** The markdown for an image, as the renderer reads it back. */
export function formatImage(src: string, alt: string, title?: string | null): string {
  const titlePart = title ? ` "${title.replace(/["\\]/g, (c) => `\\${c}`)}"` : ''
  return `![${escapeAlt(alt)}](${formatDestination(src)}${titlePart})`
}

export const ImageSchemaNode = Node.create({
  name: IMAGE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('src') ?? '',
      },
      alt: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('alt') ?? '',
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('title') || null,
        renderHTML: (attributes: Record<string, unknown>) => (attributes.title ? { title: attributes.title } : {}),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'img[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', HTMLAttributes]
  },
  markdownTokenName: 'image',
  parseMarkdown: (token, h) => {
    const { href, title, text } = token as ImageToken
    return h.createNode(IMAGE_NODE, { src: href ?? '', alt: text ?? '', title: title || null })
  },
  renderMarkdown: (node) =>
    formatImage(
      (node.attrs?.src as string) ?? '',
      (node.attrs?.alt as string) ?? '',
      node.attrs?.title as string | null,
    ),
})
