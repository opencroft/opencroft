'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowLeft } from 'lucide-react';
import { createContext, useContext, ReactNode, useState, useEffect, DependencyList } from 'react';

interface TitlebarContextValue {
  content: ReactNode;
  setContent: (content: ReactNode) => void;
}

const TitlebarContext = createContext<TitlebarContextValue | null>(null);

export function TitlebarProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);

  return (
    <TitlebarContext.Provider value={{ content, setContent }}>
      {children}
    </TitlebarContext.Provider>
  );
}
export function useTitlebarContent() {
  const context = useContext(TitlebarContext);
  if (!context) {
    throw new Error('useTitlebarContent must be used within TitlebarProvider');
  }
  return context.content;
}

export function useTitlebar(content: ReactNode, deps?: DependencyList) {
  const context = useContext(TitlebarContext);
  if (!context) {
    throw new Error('useTitlebar must be used within TitlebarProvider');
  }

  useEffect(() => {
    context.setContent(content);
    return () => {
      context.setContent(null);
    };
  }, deps || []);
}

export function TitlebarButton({ className, children, ...props }: React.ComponentProps<"button">) {
  return (
    <Button variant='ghost' className={cn('h-7', className)} {...props}>
      {children}
    </Button>
  )
}

export function BackButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <TitlebarButton className={className} {...props}>
      <ArrowLeft className='h-4 w-4' />
    </TitlebarButton>
  )
}
