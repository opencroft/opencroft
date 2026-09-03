// The audit/YOLO/sleep/live-session surface is admin-only, and this holds the
// property that a NEW server function added to the file tomorrow is gated even
// if whoever adds it does nothing to gate it: every `createServerFn` in the
// file must carry the shared `adminOnly` middleware. This file is where a hole
// once lived — three endpoints (`updateYoloMode`, `clearAuditLog`,
// `listAuditEntries`) were bare `createServerFn`s with no authorization at all:
// the pair that removes the approval gate and erases the record it was removed.
//
// This is a source check, not a runtime one, on purpose. A `createServerFn` is
// an RPC endpoint that only executes inside the server runtime's request
// context (a direct in-process call throws "No Start context found"), so a unit
// test cannot invoke one to observe the gate — the middleware's live refusal is
// proven end to end instead. What a source check
// CAN prove, and what the runtime cannot, is the universal: that no endpoint in
// the file was left ungated. It enumerates the endpoints rather than naming
// them, so it also covers the one added next.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(import.meta.dirname, 'audit-actions.ts'), 'utf-8')

// Each `export const NAME = createServerFn(...)` starts one endpoint's builder
// chain; the chain runs until the next top-level `export const` (or EOF). The
// gate is present when `.middleware([adminOnly])` appears anywhere in that
// chain, before its `.handler(`.
function endpointChains(code: string): { name: string; chain: string }[] {
  const starts = [...code.matchAll(/^export const (\w+) = createServerFn\b/gm)]
  return starts.map((m, i) => {
    const from = m.index ?? 0
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? code.length) : code.length
    return { name: m[1], chain: code.slice(from, to) }
  })
}

test('every server function on this admin surface is gated by the adminOnly middleware', () => {
  const chains = endpointChains(source)

  // Guard against a vacuous pass: if the file were renamed, emptied, or its
  // declaration shape changed so nothing matched, "all gated" would be trivially
  // true over an empty set. The surface has eight endpoints today; a change to
  // that count is a prompt to re-read this test, not to silently pass.
  assert.ok(chains.length >= 8, `expected the audit surface's server functions to be found, saw ${chains.length}`)

  const ungated = chains.filter(({ chain }) => {
    const handlerAt = chain.indexOf('.handler(')
    const gateAt = chain.indexOf('.middleware([adminOnly])')
    return gateAt === -1 || (handlerAt !== -1 && gateAt > handlerAt)
  })

  assert.deepEqual(
    ungated.map((c) => c.name),
    [],
    'these server functions reach their handler with no admin gate — attach .middleware([adminOnly])',
  )
})
