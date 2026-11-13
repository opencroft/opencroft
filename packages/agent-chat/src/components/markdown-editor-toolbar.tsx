'use client'

import { type Editor, useEditorState } from '@tiptap/react'
import { cn } from 'cn'
import { Blocks, ChevronDown, Columns3 } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { Flex } from 'ui/components/ui/layout/flex'
import { Separator } from 'ui/components/ui/separator'

import { MarkdownGridLayoutPreview } from './markdown-grid'
import {
  isMarkdownGridLayout,
  MARKDOWN_GRID_LAYOUTS,
  type MarkdownGridLayout,
  markdownGridBlockCount,
  markdownGridLayoutLabel,
} from './markdown-grid-layouts'
import { actionStates, type ButtonGroup, EDITOR_ACTIONS } from './markdown-editor-actions'
import { BLOCK_INSERTS } from './markdown-editor-block-inserts'
import { chooseSectionLayout, sectionLayoutAt } from './markdown-editor-sections'

/**
 * Which toolbar controls to offer. The chat composer wants fewer of these than
 * a documentation page does, and a surface that wants none passes `false`.
 *
 * `links` holds Link, Remove link and Hint, the inline content added in a
 * popover. `sections` is the Sections menu: blocks side by side in one of the grid's
 * layouts. `blockMenu` is the Insert menu: callouts, spoiler, tabs, table,
 * divider and icon, the same list the `/` menu offers.
 */
export type MarkdownEditorToolbarGroup = ButtonGroup | 'sections' | 'blockMenu'

export const ALL_TOOLBAR_GROUPS: MarkdownEditorToolbarGroup[] = [
  'history',
  'marks',
  'headings',
  'blocks',
  'links',
  'sections',
  'blockMenu',
]

const isButtonGroup = (group: MarkdownEditorToolbarGroup): group is ButtonGroup => group in EDITOR_ACTIONS

export function Toolbar({
  editor,
  groups,
  extra,
  className,
}: {
  editor: Editor
  groups: MarkdownEditorToolbarGroup[]
  extra?: ReactNode
  className?: string
}) {
  const actions = groups.filter(isButtonGroup).flatMap((group) => EDITOR_ACTIONS[group])
  // TipTap 3's `useEditor` re-renders on create and destroy, not on every
  // transaction; this is the subscription that keeps the buttons' states
  // following the caret.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      actions: actionStates(editor, actions),
      section: sectionLayoutAt(editor.state),
    }),
  })

  const rendered: ReactNode[] = []
  for (const group of groups) {
    if (rendered.length > 0) {
      rendered.push(<Sep key={`sep-${group}`} />)
    }
    if (isButtonGroup(group)) {
      for (const action of EDITOR_ACTIONS[group]) {
        const Icon = action.icon
        const actionState = state.actions[action.id]
        rendered.push(
          <TB
            key={action.id}
            active={actionState?.active}
            disabled={actionState ? !actionState.enabled : false}
            onClick={() => action.run(editor)}
            title={action.label}
          >
            <Icon />
          </TB>,
        )
      }
    }
    if (group === 'sections') {
      rendered.push(<SectionsMenu key='sections' editor={editor} current={state.section} />)
    }
    if (group === 'blockMenu') {
      rendered.push(<InsertMenu key='blockMenu' editor={editor} />)
    }
  }

  return (
    <Flex row align='center' className={cn('border-b p-1 gap-0.5 flex-wrap', className)}>
      {rendered}
      {extra ? (
        <>
          <div className='flex-1' />
          {extra}
        </>
      ) : null}
    </Flex>
  )
}

/**
 * The Sections menu, opened from an icon button: the grid's layouts, each
 * shown by its drawing alone and named for assistive technology and the
 * tooltip, a separator between those of different block counts. The layout of the section the caret is in is the
 * checked one, and picking another changes that section; outside a section,
 * picking one inserts a section of it.
 */
function SectionsMenu({ editor, current }: { editor: Editor; current: MarkdownGridLayout | undefined }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type='button' size='icon-sm' variant='ghost' title='Sections' aria-label='Sections'>
            <Columns3 />
          </Button>
        }
      />
      <DropdownMenuContent align='end'>
        <DropdownMenuRadioGroup
          value={current ?? ''}
          onValueChange={(layout) => {
            if (isMarkdownGridLayout(layout)) {
              chooseSectionLayout(editor, layout)
            }
          }}
        >
          {MARKDOWN_GRID_LAYOUTS.map((layout, index) => {
            const startsGroup =
              index > 0 && markdownGridBlockCount(MARKDOWN_GRID_LAYOUTS[index - 1]) !== markdownGridBlockCount(layout)
            return (
              <Fragment key={layout}>
                {startsGroup ? <DropdownMenuSeparator /> : null}
                <DropdownMenuRadioItem
                  value={layout}
                  closeOnClick
                  aria-label={markdownGridLayoutLabel(layout)}
                  title={markdownGridLayoutLabel(layout)}
                >
                  {/* 80px fills the item at the menu's narrowest: min-w-32, less its
                      paddings and the check's room. */}
                  <MarkdownGridLayoutPreview layout={layout} className='h-4 w-20' />
                </DropdownMenuRadioItem>
              </Fragment>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The Insert menu: every entry of `BLOCK_INSERTS` in its order, a separator between groups. */
function InsertMenu({ editor }: { editor: Editor }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type='button' size='sm' variant='ghost' title='Insert'>
            <Blocks />
            Insert
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align='end'>
        {BLOCK_INSERTS.map((item, index) => {
          const Icon = item.icon
          const startsGroup = index > 0 && BLOCK_INSERTS[index - 1].group !== item.group
          return (
            <Fragment key={item.id}>
              {startsGroup ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onClick={() => item.insert(editor.chain().focus()).run()}>
                <Icon />
                {item.label}
              </DropdownMenuItem>
            </Fragment>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Sep() {
  return <Separator orientation='vertical' className='mx-0.5 h-5' />
}

function TB({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <Button
      type='button'
      size='icon-sm'
      variant={active ? 'secondary' : 'ghost'}
      disabled={disabled}
      // The editor keeps the selection the button acts on: without this, the
      // mousedown moves focus out of the editable area first and the command
      // runs against a collapsed selection.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  )
}
