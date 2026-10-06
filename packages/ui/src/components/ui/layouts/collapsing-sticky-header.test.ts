import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CollapsingStickyHeader, CollapsingStickyHeaderContent, isPastHandOver } from './collapsing-sticky-header'

// The hand-over is one point on the slide, not a stretch of it: the moment the
// header has slid its whole travel and pins. Before it the full form shows,
// after it the preview does, and no scroll position sits between the two.

test('the full form shows for the whole slide and the preview only once the header is pinned', () => {
  const travel = 300
  assert.equal(isPastHandOver(-40, travel), false, 'below the container edge, at rest')
  assert.equal(isPastHandOver(0, travel), false, 'arriving at the edge')
  assert.equal(isPastHandOver(240, travel), false, 'a preview-height of travel still to go')
  assert.equal(isPastHandOver(270, travel), false, 'a scroll that stops short of the full travel')
  assert.equal(isPastHandOver(298.9, travel), false, 'more than a pixel short')
  assert.equal(isPastHandOver(299.5, travel), true, 'pinned, read a fraction of a pixel short')
  assert.equal(isPastHandOver(300, travel), true, 'pinned')
})

test('a header with no travel never hands over', () => {
  assert.equal(isPastHandOver(10, 0), false)
  assert.equal(isPastHandOver(0, 0), false)
})

test('before any scroll is measured, the full form is shown and the preview is hidden and inert', () => {
  const markup = renderToStaticMarkup(
    createElement(
      CollapsingStickyHeader,
      null,
      createElement(
        CollapsingStickyHeaderContent,
        { preview: createElement('p', null, 'preview-text') },
        createElement('p', null, 'full-text'),
      ),
    ),
  )
  const full = markup.match(/<div class="([^"]*)"[^>]*><p>full-text/)
  const preview = markup.match(/<div data-collapse-preview="" class="([^"]*)"([^>]*)><p>preview-text/)
  assert.ok(full && preview, markup)
  assert.ok(!full[1].split(' ').includes('opacity-0'), `full form visible: ${full[1]}`)
  assert.ok(preview[1].split(' ').includes('opacity-0'), `preview hidden: ${preview[1]}`)
  assert.ok(preview[1].split(' ').includes('pointer-events-none'), `preview takes no clicks: ${preview[1]}`)
  assert.match(preview[2], /aria-hidden="true"/)
  assert.match(preview[2], /inert=""/)
  assert.doesNotMatch(markup, /opacity:/, 'no scroll-linked inline opacity')
})

// A timed fade keeps running while a fast scroll carries the content on, so
// both forms would show at once. The swap lands on the frame it is decided.
test('the two forms swap without a transition', () => {
  const markup = renderToStaticMarkup(
    createElement(
      CollapsingStickyHeader,
      null,
      createElement(
        CollapsingStickyHeaderContent,
        { preview: createElement('p', null, 'preview-text') },
        createElement('p', null, 'full-text'),
      ),
    ),
  )
  assert.match(markup, /preview-text/)
  assert.doesNotMatch(markup, /transition|duration-/, markup)
})
