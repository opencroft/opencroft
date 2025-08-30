'use client';

import React from 'react';
import { TypingDots } from '@/components/ui/chat/typing-dots';
import { cn } from '@/lib/utils';

export interface ChatMessageProps extends React.HTMLAttributes<HTMLDivElement> {
  text: string;
  error?: boolean;
  renderText?: (text: string) => React.ReactNode;
}

export function ChatMessage({ text, className = '', error = false, renderText, ...props }: ChatMessageProps) {
  const isLoading = text === '...' || text === '';

  return (
    <div className={cn('flex flex-col rounded-md p-2 text-sm', className)} {...props}>
      {error ? (
        <div className="flex flex-1 gap-1.5 items-baseline">
          <span className='text-sm font-medium text-destructive'>Failed</span>
        </div>
      ) : isLoading ? (
        <div className="flex flex-1 gap-1.5 items-baseline">
          <span className='text-sm font-medium'>Typing</span>
          <TypingDots variant="primary" size='sm' />
        </div>
      ) : (
        <div className="whitespace-pre-wrap font-medium">{renderText ? renderText(text) : text}</div>
      )}
    </div>
  );
}
