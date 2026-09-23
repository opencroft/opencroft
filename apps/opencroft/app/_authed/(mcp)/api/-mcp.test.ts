import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

// A regression guard for the SHAPE of one specific mistake — NOT a proof that
// the route never derives `internal` from the request.
//
// `internal` suppresses the tool-approval gate, so a route that reads it from a
// request header hands any unauthenticated caller a way to skip approvals. The
// header this guards against (`x-opencroft-internal`) was legitimate once, when
// the app's own agents called this route over HTTP; they now bridge in-process
// and pass the flag directly, so nothing sends it and reading it is pure
// attack surface.
//
// WHAT IT CATCHES: a re-introduction that looks like the one removed —
// `internal` and `request.headers` on one line, including the two-line form,
// since the header name itself contains "internal".
//
// WHAT IT DOES NOT CATCH: a differently-named header assigned through an
// intermediate variable, or `internal` derived from the request body. Proving
// the property rather than matching its shape would take dataflow analysis,
// which is the wrong weight for a one-line fix — but the limit is worth
// stating, because a guard everyone believes is total is how the next variant
// gets through.
//
// Asserted against the source rather than through a request because the value
// never reaches a response — a caller cannot tell from the outside whether its
// header was honoured, which is exactly what makes the regression silent, and
// why a black-box test would give false comfort here.
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

// Stage B wiring. `refuses`/`mcpAuthMode` are unit-tested for
// their actual behaviour in caller.test.ts; what has to be proved HERE, at
// the route, is the ordering — the decision runs, and it runs before any tool
// gets a chance to execute. A request-level test cannot observe that ordering
// from the outside (a refused request and one that reached `handleMethod` and
// then also failed look the same from outside without deep, brittle response
// introspection), so this asserts it structurally, matching this file's
// existing approach for `internal: false` above.
test('the MCP route checks refuses() before calling handleMethod', async () => {
  const source = await readFile(join(import.meta.dirname, 'mcp.ts'), 'utf8')

  const refusalIndex = source.search(/if\s*\(\s*refuses\(/)
  const recordCallerIndex = source.indexOf('await recordCaller(')
  const handleMethodIndex = source.indexOf('await handleMethod(')

  assert.ok(refusalIndex !== -1, 'the route must call refuses() to decide whether to serve a require-mode caller')
  assert.ok(
    recordCallerIndex !== -1 && recordCallerIndex < refusalIndex,
    'the caller must be recorded before the refusal decision, so a refused request is still observed',
  )
  assert.ok(
    handleMethodIndex !== -1 && refusalIndex < handleMethodIndex,
    'a refused caller must never reach handleMethod — the check has to gate the call, not follow it',
  )
})

// The listing, guarded the same way. Extension and graph tools reach an HTTP
// caller presented — `background` offered, or the sentence said, and never
// `execution` — only because tools/list takes them from the registry's
// `listDynamicTools`, the list the in-process bridge serves too; what that list
// holds is proved in background-calls.test.ts. What has to hold HERE is that
// the route lists them no other way: before, it spread the raw declarations,
// so a marked extension or graph tool reached HTTP callers unmarked.
test('the MCP route lists extension and graph tools as the registry presents them', async () => {
  const source = await readFile(join(import.meta.dirname, 'mcp.ts'), 'utf8')

  assert.match(source, /\.\.\.\(await listDynamicTools\(\)\)/, 'tools/list must list the presented dynamic tools')
  assert.doesNotMatch(
    source,
    /getExtensionToolDefinitions|getAgentToolDefinitions/,
    'a raw declaration listed directly skips the presentation',
  )
})
