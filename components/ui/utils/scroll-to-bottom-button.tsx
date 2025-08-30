'use client';

import { ArrowDown } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

interface ScrollToBottomButtonProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function ScrollToBottomButton({ scrollContainerRef }: ScrollToBottomButtonProps) {
  const [showButton, setShowButton] = useState(false);

  const scrollToEnd = (animated: boolean) => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: animated ? 'smooth' : 'auto',
      });
    }
  };

  const handleScroll = () => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const scrollPosition = container.scrollTop + container.clientHeight;
      const scrollHeight = container.scrollHeight;
      const distanceFromBottom = scrollHeight - scrollPosition;
      const halfScreen = container.clientHeight * 0.5;
      setShowButton(distanceFromBottom > halfScreen);
    }
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [scrollContainerRef]);

  if (!showButton) {
    return null;
  }

  return (
    <Button
      onClick={() => scrollToEnd(true)}
      variant='default'
      size='icon'
      className='absolute w-14 h-14 bottom-4 right-4 rounded-full shadow-xl shadow-background/20'
    >
      <ArrowDown />
    </Button>
  );
}

export function useScrollToBottom(scrollContainerRef: React.RefObject<HTMLDivElement | null>) {
  return () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'auto',
      });
    }
  };
}
