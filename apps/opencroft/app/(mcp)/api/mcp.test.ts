import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

// The HTTP MCP route must never honour a header that grants `internal`.
//
// `internal` suppresses the tool-approval gate, so a route that reads it from a
// request header hands any unauthenticated caller a way to skip approvals. The
// header this guards against (`x-opencroft-internal`) was legitimate once, when
// the app's own agents called this route over HTTP; they now bridge in-process
// and pass the flag directly, so nothing sends it and reading it is pure
// attack surface.
//
// Asserted against the source rather than through a request because the value
// never reaches a response — a caller cannot tell from the outside whether its
// header was honoured, which is exactly what makes the regression silent.
test('the MCP route does not take `internal` from the request', async () => {
  const source = await readFile(join(import.meta.dirname, 'mcp.ts'), 'utf8')

  const honoursAHeader = /internal[^\n]*request\.headers|request\.headers[^\n]*internal/i.test(source)
  assert.equal(honoursAHeader, false, 'internal must not be derived from a request header — it skips tool approval')

  assert.match(
    source,
    /internal:\s*false/,
    'the HTTP path must pass internal: false explicitly, so the intent is visible at the call site',
  )
})
