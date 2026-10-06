'use client'

import type * as lucideIcons from 'lucide-react'
import { Box, createLucideIcon, Icon, LucideProvider, useLucideContext } from 'lucide-react'
import { iconComponent, iconExportNames } from 'ui/media/named-icon'

/**
 * The icon set extension code receives -- as `icons` from the host, and as the
 * `lucide-react` module itself, which the extension compiler resolves to this
 * object the way it resolves `react` to the host's React. Every icon export of
 * `lucide-react` is on it, each loaded on first use (see `ui/media/named-icon`),
 * so neither the host's first page nor any extension bundle carries the whole
 * set.
 *
 * `icons.<Name>` on a name that isn't a real export would be `undefined`, and
 * rendering `undefined` as a JSX element type is minified React error #130 --
 * a total, opaque crash for one wrong or renamed string, because React
 * unmounts the whole tree above the throw. The Proxy makes every access fail
 * soft instead: a name that isn't an icon logs and draws `Box`. That covers
 * `icons.<Name>` member access AND names destructured out of it (both go
 * through the same `get` trap), and a name arriving as data at runtime, which
 * no compile-time check can see, the same way as one written by hand.
 *
 * The icons are getters, so `Object.getOwnPropertyNames` lists every one --
 * which is how a bundler's CommonJS interop copies a module's named exports --
 * without any icon being loaded until it is read. `__esModule` marks it as an
 * ES module to that same interop, so it does not wrap it a second time.
 */
export function createSafeIcons(): typeof lucideIcons {
  const named: Record<string, unknown> = { createLucideIcon, Icon, LucideProvider, useLucideContext }
  Object.defineProperty(named, '__esModule', { value: true })
  for (const name of iconExportNames()) {
    Object.defineProperty(named, name, { enumerable: true, get: () => iconComponent(name, Box) })
  }
  return new Proxy(named, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string' || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver)
      }
      console.error(`[icons] "${prop}" is not a real icon export -- rendering a placeholder instead of crashing.`)
      return Box
    },
  }) as typeof lucideIcons
}
