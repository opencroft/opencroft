'use client';

import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect, ReactNode } from 'react';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import { Spinner } from '@/components/ui/utils/spinner';

interface RecyclingViewBaseProps<T> {
  items: T[];
  itemsPerPage?: number;
  onReachEnd?: () => Promise<void> | void;
  className?: string;
  innerClassName?: string;
}

interface RecyclingViewRenderItemProps<T> extends RecyclingViewBaseProps<T> {
  renderItem: (item: T, index: number) => ReactNode;
  children?: never;
}

interface RecyclingViewChildrenProps<T> extends RecyclingViewBaseProps<T> {
  children: (visibleItems: T[]) => ReactNode;
  renderItem?: never;
}

type RecyclingViewProps<T> = RecyclingViewRenderItemProps<T> | RecyclingViewChildrenProps<T>;

export function RecyclingView<T>({
  items,
  itemsPerPage = 20,
  onReachEnd,
  className,
  innerClassName,
  ...props
}: RecyclingViewProps<T>) {
  const [loadedCount, setLoadedCount] = useState(itemsPerPage);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasCheckedInitial = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const onReachEndRef = useRef(onReachEnd);
  onReachEndRef.current = onReachEnd;

  const savedScrollHeightRef = useRef(0);
  const prevFirstItemRef = useRef<T | undefined>(undefined);

  useLayoutEffect(() => {
    savedScrollHeightRef.current = scrollRef.current?.scrollHeight ?? 0;
  });

  useLayoutEffect(() => {
    if (!scrollRef.current || items.length === 0) return;
    const isFirstRender = prevFirstItemRef.current === undefined;
    const isPrepend = !isFirstRender && items[0] !== prevFirstItemRef.current;
    prevFirstItemRef.current = items[0];
    if (isPrepend) {
      const diff = scrollRef.current.scrollHeight - savedScrollHeightRef.current;
      if (diff > 0 && scrollRef.current.scrollTop > 0) {
        scrollRef.current.scrollTop += diff;
      }
    }
  }, [items]);

  const visibleItems = useMemo(() => items.slice(0, loadedCount), [items, loadedCount]);

  const checkAndLoadMore = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - clientHeight || scrollHeight <= clientHeight;
    if (!isAtBottom) return;
    if (loadedCount < items.length) {
      setLoadedCount(prev => Math.min(prev + itemsPerPage, items.length));
    } else if (onReachEndRef.current && !isLoadingMoreRef.current) {
      isLoadingMoreRef.current = true;
      setIsLoadingMore(true);
      Promise.resolve(onReachEndRef.current()).finally(() => {
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      });
    }
  }, [loadedCount, items.length, itemsPerPage]);

  useEffect(() => {
    setLoadedCount(itemsPerPage);
    hasCheckedInitial.current = false;
  }, [itemsPerPage]);

  useEffect(() => {
    if (!hasCheckedInitial.current) {
      hasCheckedInitial.current = true;
      const timer = setTimeout(checkAndLoadMore, 100);
      return () => clearTimeout(timer);
    }
  }, [checkAndLoadMore]);

  return (
    <ScrollArea
      className={className}
      innerClassName={innerClassName}
      ref={scrollRef}
      onScroll={checkAndLoadMore}
    >
      {'children' in props && props.children
        ? props.children(visibleItems)
        : 'renderItem' in props && props.renderItem
          ? visibleItems.map((item, index) => props.renderItem(item, index))
          : null}
      {isLoadingMore && (
        <div className='flex justify-center py-4'>
          <Spinner className='size-5 text-muted-foreground' />
        </div>
      )}
    </ScrollArea>
  );
}
