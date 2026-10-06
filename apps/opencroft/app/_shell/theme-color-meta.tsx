'use client'

import { useEffect } from 'react'

/**
 * Keeps `<meta name="theme-color">` on the page background of the theme in
 * effect, so an installed app's window frame follows the theme chosen in the
 * app, not only the system one. A manifest holds a single theme colour, while
 * the meta tag is re-read by the browser whenever it changes.
 *
 * The colour is read back from the rendered body, so it is the stylesheet's
 * own token rather than a copy of it. It is watched on the root element's
 * class instead of taken from `useTheme`: the theme class is applied in the
 * provider's own effect, which runs after the effects of its children.
 */
export function ThemeColorMeta() {
  useEffect(() => {
    // The tag is created here rather than declared in a route's `head`, so a
    // head re-render on navigation can never put a stale colour back.
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.append(meta)
    const sync = () => meta.setAttribute('content', toRgb(getComputedStyle(document.body).backgroundColor))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => {
      observer.disconnect()
      meta.remove()
    }
  }, [])

  return null
}

/**
 * The computed background is an `oklch()` value, which not every browser
 * accepts in theme-color; painting it onto a one-pixel canvas yields plain sRGB.
 */
function toRgb(color: string): string {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!context) {
    return color
  }
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}
