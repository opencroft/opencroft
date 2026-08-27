// The rail marker's containing block, which is what lets a sticky marker move.
//
// The marker holds the container's edge with `position: sticky`. A sticky box
// cannot leave its containing block, so the box it sits in decides whether it
// can travel at all -- and a wrapper sized to hug it gives it nowhere to go.
// That failure is silent: no error, no warning, the marker simply stops moving
// and the header slides out from under it.
//
// So the wrapper generates no box (`display: contents`) and the rail column --
// which stretches to the segment's height -- becomes the containing block. This
// asserts that, because it is exactly the kind of line a later tidy-up
// "simplifies" back to a plain wrapper, and nothing else would notice.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Chained } from './chain'

const marker = <span data-marker />

function railOf(html: string): string {
  // The rail column is the first child of the segment; the content column
  // follows it. Slicing at the content column keeps the assertions off the body.
  const end = html.indexOf('flex-1 min-w-0')
  return end === -1 ? html : html.slice(0, end)
}

test('the marker sits in a box-less wrapper, so the rail column is its containing block', () => {
  const html = renderToStaticMarkup(
    <Chained marker={marker} lineAbove={false} lineBelow={false} align='start'>
      <p>a message</p>
    </Chained>,
  )

  assert.match(railOf(html), /class="contents"/, 'the marker wrapper must generate no box')
  assert.match(html, /data-marker/, 'and the marker still renders inside it')
})

test('the wrapper does not reintroduce a size of its own', () => {
  // A wrapper that generates no box cannot also carry layout classes -- if one
  // appears here, the box is back and the sticky marker has stopped travelling.
  const html = renderToStaticMarkup(
    <Chained marker={marker} lineAbove lineBelow align='first-line'>
      <p>a message</p>
    </Chained>,
  )

  assert.doesNotMatch(railOf(html), /class="shrink-0"/, 'a hugging wrapper is what the fix removed')
})
