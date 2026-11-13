// Turning auto-approve on skips approval for every external MCP caller in the
// process, so it is an administrator's switch. A server function only runs
// inside the server runtime's request context, so this is a source check on
// its builder chain, like `audit-actions-gate.test.ts`; the HTTP refusal
// itself is not exercised here.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ADMIN_ONLY = ['setAutoApprove']

function chainOf(code: string, name: string): string | null {
  const start = code.search(new RegExp(`^export const ${name} = createServerFn\\b`, 'm'))
  if (start === -1) {
    return null
  }
  const next = code.slice(start + 1).search(/^export const /m)
  return code.slice(start, next === -1 ? code.length : start + 1 + next)
}

for (const name of ADMIN_ONLY) {
  test(`${name} carries the adminOnly middleware before its handler`, () => {
    const chain = chainOf(readFileSync(join(import.meta.dirname, 'actions.ts'), 'utf-8'), name)
    assert.ok(chain, `expected ${name} to be a server function in actions.ts`)
    const gateAt = chain.indexOf('.middleware([adminOnly])')
    assert.ok(gateAt !== -1 && gateAt < chain.indexOf('.handler('), `${name} reaches its handler with no admin gate`)
  })
}
