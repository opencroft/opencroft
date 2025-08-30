import { useState, useCallback } from 'react';

interface ArrayStateActions<T> {
  push: (item: T) => void;
  pop: () => T | undefined;
  shift: () => T | undefined;
  unshift: (item: T) => void;
  remove: (index: number) => void;
  update: (index: number, item: T) => void;
  clear: () => void;
  set: (items: T[]) => void;
  filter: (predicate: (item: T, index: number) => boolean) => void;
  map: (transform: (item: T, index: number) => T) => void;
}

export function useArrayState<T>(initialValue: T[] = []): [T[], ArrayStateActions<T>] {
  const [array, setArray] = useState<T[]>(initialValue);

  const push = useCallback((item: T) => {
    setArray(prev => [...prev, item]);
  }, []);

  const pop = useCallback(() => {
    let poppedItem: T | undefined;
    setArray(prev => {
      if (prev.length === 0) {
        return prev;
      }
      poppedItem = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    return poppedItem;
  }, []);

  const shift = useCallback(() => {
    let shiftedItem: T | undefined;
    setArray(prev => {
      if (prev.length === 0) {
        return prev;
      }
      shiftedItem = prev[0];
      return prev.slice(1);
    });
    return shiftedItem;
  }, []);

  const unshift = useCallback((item: T) => {
    setArray(prev => [item, ...prev]);
  }, []);

  const remove = useCallback((index: number) => {
    setArray(prev => prev.filter((_, i) => i !== index));
  }, []);

  const update = useCallback((index: number, item: T) => {
    setArray(prev => prev.map((current, i) => i === index ? item : current));
  }, []);

  const clear = useCallback(() => {
    setArray([]);
  }, []);

  const set = useCallback((items: T[]) => {
    setArray(items);
  }, []);

  const filter = useCallback((predicate: (item: T, index: number) => boolean) => {
    setArray(prev => prev.filter(predicate));
  }, []);

  const mapArray = useCallback((transform: (item: T, index: number) => T) => {
    setArray(prev => prev.map(transform));
  }, []);

  const actions: ArrayStateActions<T> = {
    push,
    pop,
    shift,
    unshift,
    remove,
    update,
    clear,
    set,
    filter,
    map: mapArray,
  };

  return [array, actions];
}
