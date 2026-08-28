'use client'

import { ArrowLeft } from 'lucide-react'
import { createContext, type DependencyList, type ReactNode, useContext, useEffect, useState } from 'react'
import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

interface TitlebarContextValue {
  content: ReactNode
  setContent: (content: ReactNode) => void
}

const TitlebarContext = createContext<TitlebarContextValue | null>(null)

export function TitlebarProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null)

  return <TitlebarContext.Provider value={{ content, setContent }}>{children}</TitlebarContext.Provider>
}
export function useTitlebarContent() {
  const context = useContext(TitlebarContext)
  if (!context) {
    throw new Error('useTitlebarContent must be used within TitlebarProvider')
  }
  return context.content
}

export function useTitlebar(content: ReactNode, deps?: DependencyList) {
  const context = useContext(TitlebarContext)

  // The titlebar integration is optional: when there is no TitlebarProvider in
  // the tree the hook degrades to a no-op instead of throwing, so components
  // that publish titlebar content can still be used (and server-rendered)
  // standalone.
  useEffect(() => {
    if (!context) {
      return
    }
    context.setContent(content)
    return () => {
      context.setContent(null)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: dependencies are provided by the caller
  }, deps || [])
}

export function TitlebarButton({ className, children, ...props }: React.ComponentProps<'button'>) {
  return (
    <Button variant='ghost' className={cn('h-7', className)} {...props}>
      {children}
    </Button>
  )
}

export function BackButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <TitlebarButton className={className} {...props}>
      <ArrowLeft className='h-4 w-4' />
    </TitlebarButton>
  )
}
