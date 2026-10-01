import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AgentPlanControl, AgentPlanList, type PlanEntry } from './agent-plan-control'

const ENTRIES: PlanEntry[] = [
  { content: 'read the code', status: 'completed', priority: 'high' },
  { content: 'write the fix', status: 'in_progress', priority: 'medium' },
  { content: 'run the tests', status: 'pending', priority: 'low' },
]

test('an empty plan draws no control', () => {
  assert.equal(renderToStaticMarkup(<AgentPlanControl entries={[]} />), '')
})

test('a plan with entries draws one button that says how far along it is', () => {
  const markup = renderToStaticMarkup(<AgentPlanControl entries={ENTRIES} />)
  assert.match(markup, /<button[^>]*aria-label="Plan, 1 of 3 done"/)
})

test('each entry shows its status and its priority, in the order given', () => {
  const markup = renderToStaticMarkup(<AgentPlanList entries={ENTRIES} />)
  const rows = markup.split('<li').slice(1)
  assert.equal(rows.length, 3)
  const expected = [
    ['Completed', 'read the code', 'high'],
    ['In progress', 'write the fix', 'medium'],
    ['Pending', 'run the tests', 'low'],
  ]
  expected.forEach(([status, content, priority], i) => {
    assert.ok(rows[i].includes(`aria-label="${status}"`), `row ${i} status:\n${rows[i]}`)
    assert.ok(rows[i].includes(`>${content}<`), `row ${i} content:\n${rows[i]}`)
    assert.ok(rows[i].includes(`>${priority}<`), `row ${i} priority:\n${rows[i]}`)
  })
  assert.ok(rows[0].includes('line-through'), 'a completed entry strikes through')
  assert.ok(!rows[1].includes('line-through'), 'an open entry does not')
})

test("a status outside the ACP spellings is shown in the agent's own word", () => {
  const markup = renderToStaticMarkup(
    <AgentPlanList entries={[{ content: 'wait for review', status: 'blocked', priority: '' }]} />,
  )
  assert.ok(markup.includes('aria-label="blocked"'), markup)
})

test('a status named like an object property is still shown in its own word', () => {
  const markup = renderToStaticMarkup(
    <AgentPlanList entries={[{ content: 'odd status', status: 'constructor', priority: 'low' }]} />,
  )
  assert.ok(markup.includes('aria-label="constructor"'), markup)
})
