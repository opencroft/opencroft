import { useCallback, useEffect, useRef, useState, RefObject } from 'react';

export function useFadeElement(elementRef: RefObject<HTMLElement | null>, duration: number = 300, onTransitionComplete?: () => void | Promise<void>) {
  const [opacity, setOpacity] = useState(0);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const fadeIn = useCallback(() => {
    setOpacity(1);
  }, []);

  const fadeOut = useCallback(() => {
    setOpacity(0);
  }, []);

  const fadeTransition = useCallback(() => {
    setOpacity(0);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(async () => {
      await onTransitionComplete?.();
      setOpacity(1);
    }, duration);
  }, [duration, onTransitionComplete]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    element.style.transition = `opacity ${duration}ms`;
    element.style.opacity = String(opacity);
  }, [opacity, duration, elementRef]);

  useEffect(() => {
    fadeIn();
  }, [fadeIn]);

  return {
    fadeIn,
    fadeOut,
    fadeTransition,
  };
}
