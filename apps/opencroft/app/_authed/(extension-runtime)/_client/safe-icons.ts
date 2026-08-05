'use client'

import * as lucideIcons from 'lucide-react'

/**
 * Every real icon export, computed once from the actual module rather than
 * hand-kept -- this is the ground truth both the runtime fallback below and
 * any static check validate a name against, so the two can never drift
 * apart. Also the registry itself: an author or a build step checking
 * whether a name is real reads this set instead of guessing and shipping.
 */
export const ICON_NAMES: ReadonlySet<string> = new Set(Object.keys(lucideIcons))

/**
 * `icons.<Name>` on a name that isn't a real export is `undefined`, and
 * rendering `undefined` as a JSX element type is minified React error #130
 * -- a total, opaque crash for one wrong or renamed string, because React
 * unmounts the whole tree above the throw. Wrapping the real icon namespace
 * in a Proxy makes every access fail soft instead: this is the value
 * extension code receives as `icons` in the first place, so it protects
 * `icons.<Name>` member access AND names destructured out of it (both go
 * through the same `get` trap) without any call site -- present or future,
 * inside this app's own bundled extension or a third-party one -- having to
 * remember to check first. A name arriving as data at runtime, which no
 * compile-time check can see, is covered the same way as one written by hand.
 */
export function createSafeIcons(): typeof lucideIcons {
  return new Proxy(lucideIcons, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (value !== undefined) {
        return value
      }
      if (typeof prop === 'string') {
        console.error(`[icons] "${prop}" is not a real icon export -- rendering a placeholder instead of crashing.`)
      }
      return lucideIcons.Box
    },
  }) as typeof lucideIcons
}
