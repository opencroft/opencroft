'use client'

import React, { useCallback } from 'react'
import { MenuLayout, type MenuLayoutProps } from 'ui/layout/menulayout'
import { ScrollContent, ScrollFooter, ScrollPage } from 'ui/layout/scrollpage'

import { useUrlState } from '@/components/hooks/use-url-state'
import { cn } from '@/lib/utils'

// ---- MenuContent ----

export interface MenuContentProps {
  id: string
  label: string
  icon?: React.ElementType
  children: React.ReactNode
}

export function MenuContent(_props: MenuContentProps) {
  return null // rendered by UrlMenuLayout
}

// ---- MenuPage ----

export interface MenuPageProps {
  id: string
  label: string
  icon?: React.ElementType
  children: React.ReactNode
}

export function MenuPage(_props: MenuPageProps) {
  return null // rendered by UrlMenuLayout
}

// ---- MenuFooter ----

export interface MenuFooterProps {
  id: string
  children: React.ReactNode
}

export function MenuFooter(_props: MenuFooterProps) {
  return null // rendered by UrlMenuLayout
}

// ---- UrlMenuLayout ----

export interface UrlMenuLayoutProps extends Omit<MenuLayoutProps, 'isOpened' | 'onClosed' | 'menu' | 'children'> {
  param?: string
  defaultValue?: string
  children: React.ReactNode
}

export function UrlMenuLayout({ param = 'section', defaultValue = '', children, ...props }: UrlMenuLayoutProps) {
  const [rawValue, setValue] = useUrlState<string>(param, '')
  const value = rawValue || defaultValue
  const onClosed = useCallback(() => setValue(''), [setValue])

  const allChildren = React.Children.toArray(children)

  const sections = allChildren.filter(
    (child): child is React.ReactElement<MenuContentProps | MenuPageProps> =>
      React.isValidElement(child) && (child.type === MenuContent || child.type === MenuPage),
  )

  const footers = allChildren.filter(
    (child): child is React.ReactElement<MenuFooterProps> => React.isValidElement(child) && child.type === MenuFooter,
  )

  const activeSection = sections.find((s) => s.props.id === value) ?? sections[0]
  const activeFooter = footers.find((f) => f.props.id === activeSection?.props.id)

  const menu = (
    <nav className='p-2 space-y-1'>
      {sections.map(({ props: s }) => {
        const Icon = s.icon
        return (
          <button
            key={s.id}
            onClick={() => setValue(s.id)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              value === s.id ? 'bg-accent font-medium' : 'hover:bg-accent/50',
            )}
          >
            {Icon && React.createElement(Icon as React.FC<{ className: string }>, { className: 'h-4 w-4 shrink-0' })}
            {s.label}
          </button>
        )
      })}
    </nav>
  )

  const pageContent =
    activeSection?.type === MenuPage ? (
      activeSection.props.children
    ) : (
      <ScrollPage>
        <ScrollContent className='p-4'>{activeSection?.props.children}</ScrollContent>
        {activeFooter && <ScrollFooter className='justify-end px-4'>{activeFooter.props.children}</ScrollFooter>}
      </ScrollPage>
    )

  return (
    <MenuLayout isOpened={!!rawValue} onClosed={onClosed} menu={menu} {...props}>
      {pageContent}
    </MenuLayout>
  )
}
