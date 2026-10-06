import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agentEditNewStyle, agentEditPlan } from './agent-edit'

test('a replacement is swept, then the new text comes in, all within about three seconds', () => {
  const plan = agentEditPlan({ replaces: true })
  assert.ok(plan.oldGone > 0, 'the replaced text is swept first')
  assert.ok(plan.end > plan.oldGone)
  assert.ok(plan.end <= 3_000, `over by 3 s (${plan.end} ms)`)
})

test('an insertion has nothing to sweep and arrives at once', () => {
  const plan = agentEditPlan({ replaces: false })
  assert.equal(plan.oldGone, 0)
  assert.ok(plan.end <= 3_000)
})

test('reduced motion is one brief highlight, nothing swept', () => {
  const plan = agentEditPlan({ replaces: true }, { reducedMotion: true })
  assert.equal(plan.oldGone, 0)
  assert.ok(plan.end <= 1_000)
  assert.match(agentEditNewStyle(plan, 'violet'), /agent-edit-highlight/)
  assert.match(agentEditNewStyle(agentEditPlan({ replaces: true }), 'violet'), /agent-edit-arrive/)
})
