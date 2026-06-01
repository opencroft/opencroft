import { useMemo, useState } from 'react'

interface SignalState<T> {
  get value(): T
  set value(v: T)
}

export function useSignalState<T>(initial: T): SignalState<T> {
  const [value, setValue] = useState(initial)

  return useMemo(
    () => ({
      get value() {
        return value
      },
      set value(v: T) {
        setValue(v)
      },
    }),
    [value],
  )
}
