import { TextSelection } from '@tiptap/pm/state'
import type { ChainedCommands } from '@tiptap/react'
import { ListCollapse, Minus, PanelsTopLeft, Table } from 'lucide-react'

import type { MarkdownBlockMenuItem } from './components/markdown-block-menu'
import { MARKDOWN_CALLOUT_KINDS, markdownCalloutKind } from './components/markdown-callout'
import { DIRECTIVE_NODES } from './markdown-editor-directives'

/**
 * A block the editor offers to insert beyond the ones typed as markdown. The
 * toolbar's Blocks menu and the `/` menu both list exactly these, in this
 * order, so the two can never offer different things.
 *
 * The simple elements -- headings, lists, quotes, code, a divider -- are
 * typed as their markdown (`#`, `-`, `>`, a backtick fence, `---`). The
 * divider is in both places: `---` and an entry here.
 */
export interface BlockInsert extends MarkdownBlockMenuItem {
  /** Other words the `/` menu finds it by. */
  keywords: string[]
  /** Which run of the menu it belongs to; the toolbar menu separates runs. */
  group: 'callout' | 'block'
  /** Queue the insertion on a chain whose selection is where the block goes. */
  insert: (chain: ChainedCommands) => ChainedCommands
}

function insertTabs(chain: ChainedCommands): ChainedCommands {
  const tab = (heading: string) => ({
    type: DIRECTIVE_NODES.tab,
    attrs: { heading },
    content: [{ type: 'paragraph' }],
  })
  return (
    chain
      .insertContent({ type: DIRECTIVE_NODES.tabs, content: [tab('Tab 1'), tab('Tab 2')] })
      // Insertion leaves the caret at the end of what it inserted, which is
      // the last tab; writing starts in the first.
      .command(({ tr }) => {
        const { $from } = tr.selection
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name === DIRECTIVE_NODES.tabs) {
            tr.setSelection(TextSelection.near(tr.doc.resolve($from.before(depth) + 2)))
            return true
          }
        }
        return true
      })
  )
}

export const BLOCK_INSERTS: readonly BlockInsert[] = [
  ...MARKDOWN_CALLOUT_KINDS.map(
    (kind): BlockInsert => ({
      id: kind,
      label: markdownCalloutKind(kind).title,
      icon: markdownCalloutKind(kind).icon,
      keywords: ['callout', 'admonition'],
      group: 'callout',
      insert: (chain) => chain.wrapIn(DIRECTIVE_NODES.callout, { kind }),
    }),
  ),
  {
    id: 'spoiler',
    label: 'Spoiler',
    icon: ListCollapse,
    keywords: ['details', 'collapse', 'toggle'],
    group: 'block',
    insert: (chain) => chain.wrapIn(DIRECTIVE_NODES.spoiler),
  },
  {
    id: 'tabs',
    label: 'Tabs',
    icon: PanelsTopLeft,
    keywords: ['tab', 'alternatives'],
    group: 'block',
    insert: insertTabs,
  },
  {
    id: 'table',
    label: 'Table',
    icon: Table,
    keywords: ['grid'],
    group: 'block',
    insert: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: Minus,
    keywords: ['rule', 'separator', 'hr', 'line'],
    group: 'block',
    insert: (chain) => chain.setHorizontalRule(),
  },
]

/**
 * The inserts a `/` query offers: those whose name starts with it, or -- only
 * when none does -- those whose name or keywords contain it. `/ta` offers Tabs
 * and Table and nothing that merely has "ta" inside it; `/rule` still finds
 * Divider. The same rule the chat composer's command popup follows.
 */
export function matchBlockInserts(query: string): BlockInsert[] {
  const lower = query.toLowerCase()
  const prefixed = BLOCK_INSERTS.filter((item) => item.label.toLowerCase().startsWith(lower))
  if (prefixed.length > 0) {
    return prefixed
  }
  return BLOCK_INSERTS.filter((item) =>
    [item.label, ...item.keywords].some((word) => word.toLowerCase().includes(lower)),
  )
}
