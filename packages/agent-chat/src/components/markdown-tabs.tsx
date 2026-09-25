import { Plus, X } from 'lucide-react'
import { Fragment, type ReactNode, useRef, useState } from 'react'
import { Button } from 'ui/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from 'ui/components/ui/tabs'

export interface MarkdownTab {
  /** The tab's name in the strip. */
  label: string
  /** What the tab shows when it is selected. Unused when `panel` is given. */
  content?: ReactNode
}

export interface MarkdownTabsProps {
  /** In the order they appear; the first is selected unless `active` says otherwise. */
  tabs: MarkdownTab[]
  /**
   * The selected tab's index, for a host that owns the selection -- an editor
   * selects the tab the caret is in. Pair with `onActiveChange`.
   */
  active?: number
  onActiveChange?: (index: number) => void
  /**
   * Shown beneath the strip in place of the tabs' own contents. For an editor,
   * whose editable content is one region that shows the selected tab itself.
   */
  panel?: ReactNode
  /** Adds a `+` after the strip. For an editor. */
  onAdd?: () => void
  /** Lets a tab be renamed in place by double-clicking it. For an editor. */
  onRename?: (index: number, label: string) => void
  /**
   * Puts a remove control after the selected tab, while there is more than one
   * to choose from. For an editor. Removing the last tab is removing the block,
   * which the editor already does by deleting it.
   */
  onRemove?: (index: number) => void
}

// A panel sits flush under the strip: the gap between them is the spacing, not
// the first and last paragraph's margins. Important, because a surrounding
// prose stylesheet (unlayered CSS) outranks a plain utility and would put its
// paragraph margins back.
const PANEL = '[&>*:first-child]:mt-0! [&>*:last-child]:mb-0!'

/**
 * Alternatives shown one at a time: the same command for three package
 * managers, the same step on each platform.
 *
 * Given the editing props it is the same block made editable. The strip is
 * then kept out of the surrounding editable text (`contentEditable={false}`),
 * so a rich-text editor hosting the block treats it as controls rather than as
 * prose to type into.
 */
export function MarkdownTabs({ tabs, active, onActiveChange, panel, onAdd, onRename, onRemove }: MarkdownTabsProps) {
  const [renaming, setRenaming] = useState<number | null>(null)
  const editing = Boolean(onAdd || onRename || onRemove || panel !== undefined)
  // Beside the selected tab rather than on hover, so a touch screen can reach it.
  const removable = onRemove && tabs.length > 1 ? (active ?? 0) : null
  const selection =
    active === undefined
      ? { defaultValue: '0' }
      : { value: String(active), onValueChange: (value: unknown) => onActiveChange?.(Number(value)) }
  return (
    // String values: both the Radix and the Base UI tabs primitive accept them.
    <Tabs {...selection} className='my-2'>
      <div contentEditable={editing ? false : undefined} className='flex min-w-0 items-center gap-1'>
        {/* Scrolls sideways when the labels outgrow the column. The vertical
            axis is clipped explicitly: with only `overflow-x` set, `overflow-y`
            computes to `auto` as well, and the list showed a vertical
            scrollbar. */}
        <TabsList className='max-w-full overflow-x-auto overflow-y-hidden'>
          {tabs.map((tab, index) =>
            renaming === index && onRename ? (
              <TabLabelInput
                // biome-ignore lint/suspicious/noArrayIndexKey: tabs never reorder while one is renamed
                key={index}
                label={tab.label}
                onDone={(label) => {
                  setRenaming(null)
                  if (label !== null) {
                    onRename(index, label)
                  }
                }}
              />
            ) : (
              // Two tabs may share a label; their position is what tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: tabs never reorder
              <Fragment key={index}>
                <TabsTrigger value={String(index)} onDoubleClick={onRename ? () => setRenaming(index) : undefined}>
                  {tab.label || `Tab ${index + 1}`}
                </TabsTrigger>
                {removable === index && onRemove ? (
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-xs'
                    onClick={() => onRemove(index)}
                    title='Remove tab'
                    aria-label={`Remove tab ${tab.label || index + 1}`}
                  >
                    <X />
                  </Button>
                ) : null}
              </Fragment>
            ),
          )}
        </TabsList>
        {onAdd ? (
          <Button type='button' variant='ghost' size='icon-xs' onClick={onAdd} title='Add tab' aria-label='Add tab'>
            <Plus />
          </Button>
        ) : null}
      </div>
      {panel !== undefined ? (
        <div className={PANEL}>{panel}</div>
      ) : (
        tabs.map((tab, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tabs never reorder
          <TabsContent key={index} value={String(index)} className={PANEL}>
            {tab.content}
          </TabsContent>
        ))
      )}
    </Tabs>
  )
}

/**
 * A tab's name being edited where the tab sits. Enter or leaving the field
 * keeps the new name; Escape keeps the old one (reported as null).
 */
function TabLabelInput({ label, onDone }: { label: string; onDone: (label: string | null) => void }) {
  const [draft, setDraft] = useState(label)
  // Reports once: a blur can still arrive after Enter or Escape has answered,
  // and it must not turn an Escape into a rename.
  const answered = useRef(false)
  const answer = (value: string | null) => {
    if (!answered.current) {
      answered.current = true
      onDone(value)
    }
  }
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field appears because the reader asked to rename this tab
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => answer(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          answer(draft)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          answer(null)
        }
      }}
      aria-label='Tab name'
      className='h-full w-28 min-w-0 rounded-md bg-background px-2 text-sm outline-none ring-1 ring-ring'
    />
  )
}
