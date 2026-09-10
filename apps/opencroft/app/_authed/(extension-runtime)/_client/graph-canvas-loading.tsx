'use client'

import { LogoLoader } from 'ui/logo-loader'

/**
 * The wait shown before a graph is on screen.
 *
 * There are two such waits and they run back to back: the host fetches this
 * surface's chunk, and then the canvas resolves which graph it was pointed at.
 * They are ONE component rather than two identical ones, because the property
 * that makes them read as a single wait is that they look the same -- and
 * nothing in this repository can see that stop being true. jsdom measures every
 * element as zero, so no rendering test can compare them; a `className` is a
 * string, so the compiler cannot either. Two copies would leave the invariant
 * stated only in prose, which is the form that rots without anyone noticing.
 *
 * It lives in its own file rather than in the canvas because the host cannot
 * import it from there: reaching the canvas statically is exactly the edge the
 * host deliberately does not have. See host-import-graph.test.ts.
 */
export function GraphCanvasLoading() {
  return (
    <div className='flex h-full min-h-24 items-center justify-center'>
      <LogoLoader size={40} className='text-foreground' />
    </div>
  )
}
