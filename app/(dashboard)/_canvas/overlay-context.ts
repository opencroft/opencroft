'use client';

import * as React from 'react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

type Slot = 'header' | 'content' | 'menu' | 'bar';

interface OverlayContextValue {
  setSlot: (slot: Slot, node: ReactNode | null) => void;
  containerRef: React.RefObject<HTMLElement | null>;
}

export const OverlayContext = createContext<OverlayContextValue>({
  setSlot: () => { },
  containerRef: { current: null },
});

function useOverlaySlot(slot: Slot, node: ReactNode | null): void {
  const { setSlot } = useContext(OverlayContext);
  useLayoutEffect(() => {
    setSlot(slot, node);
  }, [slot, node, setSlot]);
  useLayoutEffect(() => () => setSlot(slot, null), [slot, setSlot]);
}

export function useOverlayHeader(node: ReactNode | null) {
  useOverlaySlot('header', node);
}

export function useOverlayContent(node: ReactNode | null) {
  useOverlaySlot('content', node);
}

export function useOverlayMenu(node: ReactNode | null) {
  useOverlaySlot('menu', node);
}

export function useOverlayBar(node: ReactNode | null) {
  useOverlaySlot('bar', node);
}

export interface OverlaySlots {
  header: ReactNode | null;
  content: ReactNode | null;
  menu: ReactNode | null;
  bar: ReactNode | null;
  setSlot: (slot: Slot, node: ReactNode | null) => void;
  containerRef: React.RefObject<HTMLElement | null>;
}

export function useOverlayState(): OverlaySlots {
  const [header, setHeader] = useState<ReactNode | null>(null);
  const [content, setContent] = useState<ReactNode | null>(null);
  const [menu, setMenu] = useState<ReactNode | null>(null);
  const [bar, setBar] = useState<ReactNode | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const setSlot = useCallback((slot: Slot, node: ReactNode | null) => {
    if (slot === 'header') {
      setHeader(node);
      return;
    }
    if (slot === 'content') {
      setContent(node);
      return;
    }
    if (slot === 'menu') {
      setMenu(node);
      return;
    }
    setBar(node);
  }, []);

  return { header, content, menu, bar, setSlot, containerRef };
}

export function useOverlayClose(active: boolean, onClose: () => void) {
  const { containerRef } = useContext(OverlayContext);
  useEffect(() => {
    if (!active) {
      return;
    }
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) {
        return;
      }
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, onClose, containerRef]);
}
