// The audit/YOLO/sleep/live-session surface is admin-only, and so is each
// surface listed in SURFACES below. This holds the property that a NEW server
// function added to one of those files tomorrow is gated even if whoever adds
// it does nothing to gate it: every `createServerFn` in the file must carry the
// shared `adminOnly` middleware. The audit file matters most: `updateYoloMode`
// removes the approval gate, `clearAuditLog` erases the record that it was
// removed, and `listAuditEntries` reads that record.
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

// Each admin-only surface, with how many endpoints it has today. The instance
// keys surface answers where the keys come from and the key file's warning,
// which only an administrator is shown. The extension registries surface is
// instance configuration whose credential picks name Secrets Stores anywhere.
// The backup surface reads, restores and resets the whole instance.
const SURFACES = [
  { file: 'audit-actions.ts', endpoints: 8 },
  { file: 'instance-keys-actions.ts', endpoints: 2 },
  { file: 'extension-registries-actions.ts', endpoints: 5 },
  { file: 'backup-actions.ts', endpoints: 9 },
]

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

for (const surface of SURFACES) {
  test(`every server function in ${surface.file} is gated by the adminOnly middleware`, () => {
    const chains = endpointChains(readFileSync(join(import.meta.dirname, surface.file), 'utf-8'))

    // Guard against a vacuous pass: if the file were renamed, emptied, or its
    // declaration shape changed so nothing matched, "all gated" would be trivially
    // true over an empty set. A change to the count is a prompt to re-read this
    // test, not to silently pass.
    assert.ok(
      chains.length >= surface.endpoints,
      `expected ${surface.file}'s server functions to be found, saw ${chains.length}`,
    )

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
}
