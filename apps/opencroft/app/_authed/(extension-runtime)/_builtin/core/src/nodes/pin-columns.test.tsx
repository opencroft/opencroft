// A card's pins as rows: the markup, not the layout a browser gives it.
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { PinColumns } from './pin-columns'

const pin = (id: string) => <i key={id}>{id}</i>

test('inputs and outputs are two columns side by side, each from its first row', () => {
  const html = renderToStaticMarkup(<PinColumns inputs={[pin('a'), pin('b')]} outputs={[pin('out')]} />)
  const root = /^<div[^>]*>(<div[^>]*>(.*?)<\/div>)(<div[^>]*>(.*?)<\/div>)<\/div>$/.exec(html)
  assert.ok(root, html)
  assert.equal(root[2], '<i>a</i><i>b</i>', 'the inputs, in order')
  assert.equal(root[4], '<i>out</i>', 'the output, in its own column beside them')
})

test('pins on one side only are one column, and none are nothing', () => {
  assert.equal(
    renderToStaticMarkup(<PinColumns inputs={[]} outputs={[pin('value')]} />).match(/<div/g)?.length,
    1,
    'a constant has its output across the card',
  )
  assert.equal(renderToStaticMarkup(<PinColumns inputs={[]} outputs={[]} />), '')
})
