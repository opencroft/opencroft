import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { ReferenceChip } from './reference-chip'

const state = <b data-state=''>In Progress</b>
const mark = <i data-mark=''>glyph</i>

// The chip's parts in document order, by what each one holds.
function order(html: string): string[] {
  const found: Array<[number, string]> = [
    [html.indexOf('data-state'), 'state'],
    [html.indexOf('data-mark'), 'mark'],
    [html.indexOf('>DEMO-42<'), 'label'],
    [html.indexOf('>Login fails'), 'detail'],
  ]
  return found
    .filter(([at]) => at >= 0)
    .sort(([a], [b]) => a - b)
    .map(([, part]) => part)
}

test('state comes first, then the mark, the label and the detail', () => {
  const html = renderToStaticMarkup(
    <ReferenceChip label='DEMO-42' detail='Login fails after a reset' state={state} icon={mark} href='/t' />,
  )
  assert.deepEqual(order(html), ['state', 'mark', 'label', 'detail'])
})

test('the label never truncates; the detail truncates first; the state gives way last', () => {
  const html = renderToStaticMarkup(
    <ReferenceChip label='DEMO-42' detail='Login fails after a reset' state={state} icon={mark} href='/t' />,
  )
  assert.match(html, /<span class="shrink-0 whitespace-nowrap">DEMO-42<\/span>/)
  assert.match(html, /<span class="min-w-0 shrink-\[1000\] line-clamp-1 \[overflow-wrap:anywhere\]">Login fails/)
  // Not a flex share: capped, so a short status is never clipped by a sliver.
  assert.match(
    html,
    /<span class="inline-flex min-w-0 shrink-0 max-w-\[calc\(100%-5rem\)\] self-center"><b data-state="">/,
  )
})

test('an unknown chip shows the identifier alone, with no state', () => {
  const html = renderToStaticMarkup(<ReferenceChip label='DEMO-99999' state={state} tone='info' status='unknown' />)
  assert.deepEqual(order(html), [])
  assert.match(html, /border-dashed/)
  assert.match(html, />DEMO-99999</)
})

test('without a state or detail the chip is the label and its mark, as before', () => {
  const html = renderToStaticMarkup(<ReferenceChip label='Build server' icon={mark} onOpen={() => {}} />)
  assert.deepEqual(order(html), ['mark'])
  assert.match(html, /<button type="button"/)
  assert.doesNotMatch(html, /line-clamp-1/)
})
