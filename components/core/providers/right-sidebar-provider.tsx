'use client'

import type React from 'react'
import { createContext, useContext } from 'react'

import { SidebarProvider, useSidebar } from '@/components/ui/sidebar'

interface RightSidebarContextValue {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const RightSidebarContext = createContext<RightSidebarContextValue | null>(null)

interface RightSidebarProviderProps {
  children: React.ReactNode
  defaultOpen?: boolean
  className?: string
  style?: React.CSSProperties
}

function RightSidebarProviderContent({ children }: { children: React.ReactNode }) {
  const sidebarValue = useSidebar()

  return <RightSidebarContext.Provider value={sidebarValue}>{children}</RightSidebarContext.Provider>
}

export function RightSidebarProvider({ children, defaultOpen = false, className, style, ...props }: RightSidebarProviderProps) {
  return (
    <SidebarProvider defaultOpen={defaultOpen} className={className} style={style} {...props}>
      <RightSidebarProviderContent>{children}</RightSidebarProviderContent>
    </SidebarProvider>
  )
}

export function useRightSidebar() {
  const context = useContext(RightSidebarContext)
  if (!context) {
    throw new Error('useRightSidebar must be used within a RightSidebarProvider')
  }
  return context
}
