import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from 'ui/components/ui/tabs'

export interface MarkdownTab {
  /** The tab's name in the strip. */
  label: string
  /** What the tab shows when it is selected. */
  content: ReactNode
}

export interface MarkdownTabsProps {
  /** In the order they appear; the first is selected. */
  tabs: MarkdownTab[]
}

/**
 * Alternatives shown one at a time: the same command for three package
 * managers, the same step on each platform.
 */
export function MarkdownTabs({ tabs }: MarkdownTabsProps) {
  return (
    // String values: both the Radix and the Base UI tabs primitive accept them.
    <Tabs defaultValue='0' className='my-2'>
      {/* Scrolls sideways when the labels outgrow the column. The vertical
          axis is clipped explicitly: with only `overflow-x` set, `overflow-y`
          computes to `auto` as well, and the list showed a vertical
          scrollbar. */}
      <TabsList className='max-w-full overflow-x-auto overflow-y-hidden'>
        {tabs.map((tab, index) => (
          // Two tabs may share a label; their position is what tells them apart.
          // biome-ignore lint/suspicious/noArrayIndexKey: tabs never reorder
          <TabsTrigger key={index} value={String(index)}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tabs never reorder
        <TabsContent key={index} value={String(index)} className='[&>*:first-child]:mt-0 [&>*:last-child]:mb-0'>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
