import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AccountCard } from './account-card'

const text = (html: string) => html.replace(/<[^>]*>/g, '')

test('the card shows the username plain, with no at-sign', () => {
  const html = renderToStaticMarkup(<AccountCard kind='user' name='Sam Rivera' username='sam' />)
  assert.ok(text(html).endsWith('Sam Riverasam'), text(html))
  assert.ok(!text(html).includes('@'))
})

test('an agent is marked by the word Agent alone, with no icon', () => {
  const agent = renderToStaticMarkup(<AccountCard kind='agent' name='Ada' username='agent.ada' />)
  const person = renderToStaticMarkup(<AccountCard kind='user' name='Ada' username='agent.ada' />)
  assert.ok(text(agent).includes('AdaAgent'))
  assert.ok(!text(person).includes('Agent'))
  // The avatar's own drawing is the same for both, so any extra svg is a mark.
  assert.equal(agent.split('<svg').length, person.split('<svg').length)
})
