"use client"

import * as React from "react"
import { useMemo } from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/layout/scroll-area"
import { RecyclingView } from "@/components/ui/layout/recycling-view"
import { GridSize, gridSizeClasses } from "@/components/ui/layout/grid"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// PopupRecyclingContent internal renderer
// ---------------------------------------------------------------------------

type FlatEntry<T> =
  | { type: 'header'; name: string }
  | { type: 'item'; item: T; groupIndex: number }

interface RecyclingGroup<T> { name: string; items: T[] }

export interface PopupRecyclingContentProps<T = any> {
  groups: RecyclingGroup<T>[]
  renderItem: (item: T, groupIndex: number) => React.ReactNode
  gridSize?: GridSize
  itemsPerPage?: number
  className?: string
}

function PopupRecyclingRenderer<T>({
  groups,
  renderItem,
  gridSize = 'small',
  itemsPerPage = 60,
  className,
}: PopupRecyclingContentProps<T>) {
  const flatEntries = useMemo((): FlatEntry<T>[] =>
    groups.flatMap((g, gi) => [
      ...(g.name ? [{ type: 'header' as const, name: g.name }] : []),
      ...g.items.map(item => ({ type: 'item' as const, item, groupIndex: gi })),
    ])
  , [groups])

  return (
    <RecyclingView
      items={flatEntries}
      itemsPerPage={itemsPerPage}
      className={className ?? 'flex-1'}
      innerClassName={`${gridSizeClasses[gridSize]} gap-2 p-2`}
    >
      {(visibleItems) => visibleItems.map((entry, i) => {
        if (entry.type === 'header') return (
          <div
            key={`h-${entry.name}-${i}`}
            className="col-span-full sticky top-0 bg-background z-10 py-2 text-sm font-medium text-muted-foreground border-b"
          >
            {entry.name}
          </div>
        )
        return renderItem(entry.item, entry.groupIndex)
      })}
    </RecyclingView>
  )
}

// ---------------------------------------------------------------------------
// Slot components — render nothing themselves, used as typed data carriers
// ---------------------------------------------------------------------------

export interface PopupHeaderProps {
  children?: React.ReactNode
}

function PopupHeader(_props: PopupHeaderProps) { return null }

export interface PopupSubHeaderProps {
  children?: React.ReactNode
  className?: string
}

function PopupSubHeader(_props: PopupSubHeaderProps) { return null }

export interface PopupContentProps {
  children?: React.ReactNode
  className?: string
}

function PopupContent(_props: PopupContentProps) { return null }

export interface PopupFooterProps {
  children?: React.ReactNode
}

function PopupFooter(_props: PopupFooterProps) { return null }

function PopupRecyclingContent<T>(_props: PopupRecyclingContentProps<T>) { return null }

// ---------------------------------------------------------------------------
// Slot extraction
// ---------------------------------------------------------------------------

interface Slots {
  header: React.ReactElement<PopupHeaderProps> | null
  subHeader: React.ReactElement<PopupSubHeaderProps> | null
  content: React.ReactElement<PopupContentProps> | null
  recyclingContent: React.ReactElement<PopupRecyclingContentProps> | null
  footer: React.ReactElement<PopupFooterProps> | null
  rest: React.ReactNode[]
}

function extractSlots(children: React.ReactNode): Slots {
  const slots: Slots = { header: null, subHeader: null, content: null, recyclingContent: null, footer: null, rest: [] }
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) { slots.rest.push(child); return }
    if (child.type === PopupHeader) slots.header = child as React.ReactElement<PopupHeaderProps>
    else if (child.type === PopupSubHeader) slots.subHeader = child as React.ReactElement<PopupSubHeaderProps>
    else if (child.type === PopupContent) slots.content = child as React.ReactElement<PopupContentProps>
    else if (child.type === PopupRecyclingContent) slots.recyclingContent = child as React.ReactElement<PopupRecyclingContentProps>
    else if (child.type === PopupFooter) slots.footer = child as React.ReactElement<PopupFooterProps>
    else slots.rest.push(child)
  })
  return slots
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface AdaptivePopupProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger?: React.ReactNode
  contentClassName?: string
  children: React.ReactNode
  expanded?: boolean
}

function AdaptivePopup({
  open,
  onOpenChange,
  trigger,
  contentClassName,
  children,
  expanded = false,
}: AdaptivePopupProps) {
  const isMobileRaw = useIsMobile()
  const lockedMobileRef = React.useRef(isMobileRaw)
  if (!open) lockedMobileRef.current = isMobileRaw
  const isMobile = lockedMobileRef.current

  const slots = extractSlots(children)

  const resolvedContent = slots.content ? slots.content.props.children : slots.rest
  const resolvedContentCls = slots.content?.props.className ?? contentClassName
  const resolvedFooter = slots.footer?.props.children
  const recyclingProps = slots.recyclingContent?.props

  const drawerHead = slots.header
    ? <DrawerHeader>{slots.header.props.children}</DrawerHeader>
    : null

  const dialogHead = slots.header
    ? <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">{slots.header.props.children}</DialogHeader>
    : null

  const subHeader = slots.subHeader
    ? <div className={cn("shrink-0 border-b px-4 py-2", slots.subHeader.props.className)}>{slots.subHeader.props.children}</div>
    : null

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {trigger && <DrawerTrigger asChild>{trigger}</DrawerTrigger>}
        <DrawerContent
          className="flex flex-col min-h-[97dvh]"
          onAnimationEnd={(e) => {
            const el = e.currentTarget as HTMLDivElement
            el.style.transform = ""
            el.style.willChange = "auto"
          }}
        >
          <DrawerTitle className="sr-only">Dialog</DrawerTitle>
          {drawerHead}
          {subHeader}
          <div className="flex flex-1 min-h-0 overflow-hidden border-t">
            {recyclingProps
              ? <PopupRecyclingRenderer {...recyclingProps} className="flex-1" />
              : <ScrollArea className="flex-1" innerClassName={cn("p-4", resolvedContentCls)}>{resolvedContent}</ScrollArea>
            }
          </div>
          {resolvedFooter && <DrawerFooter className="p-0">{resolvedFooter}</DrawerFooter>}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        className={cn(
          "flex flex-col p-0 gap-0 overflow-hidden sm:max-w-4xl",
          expanded ? "h-[90vh]" : "max-h-[90vh]"
        )}
      >
        <DialogTitle className="sr-only">Dialog</DialogTitle>
        {dialogHead}
        {subHeader}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {recyclingProps
            ? <PopupRecyclingRenderer {...recyclingProps} className="flex-1" />
            : <ScrollArea className="flex-1" innerClassName={cn("p-6", resolvedContentCls)}>{resolvedContent}</ScrollArea>
          }
        </div>
        {resolvedFooter && <div className="shrink-0 border-t">{resolvedFooter}</div>}
      </DialogContent>
    </Dialog>
  )
}

export { AdaptivePopup, PopupHeader, PopupSubHeader, PopupContent, PopupRecyclingContent, PopupFooter }
