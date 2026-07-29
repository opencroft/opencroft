import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { markdownLinkComponents } from './markdown-link'

test('renders a link that opens in a new tab without handing it window.opener', () => {
  const Link = markdownLinkComponents.a as (props: { href: string; children: string }) => ReactElement
  const html = renderToStaticMarkup(<Link href='https://example.com'>example</Link>)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /href="https:\/\/example\.com"/)
})
