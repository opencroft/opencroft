import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  buildBase64WriteCommands,
  buildLocalExtensionCtx,
  capColumns,
  globPatternToEre,
  insideExcludedDir,
  isValidLocalExtensionSlug,
  replaceExact,
  requireCallingAgent,
  resolveRemoteFilePath,
  resolveTerminalContext,
} from './tools'

// ── isValidLocalExtensionSlug ──────────────────────────────────────────────

test('isValidLocalExtensionSlug accepts conservative slugs', () => {
  for (const slug of ['git', 'terraform', 'my-ext', 'my_ext', 'ext.v2', 'a1', 'A1']) {
    assert.equal(isValidLocalExtensionSlug(slug), true, `expected "${slug}" to be valid`)
  }
})

test('isValidLocalExtensionSlug rejects empty string', () => {
  assert.equal(isValidLocalExtensionSlug(''), false)
})

test('isValidLocalExtensionSlug rejects path traversal and separators', () => {
  for (const slug of ['..', '../etc', '../../etc/passwd', 'a/b', 'a\\b', 'a..b/c', '/etc/passwd', 'a/..']) {
    assert.equal(isValidLocalExtensionSlug(slug), false, `expected "${slug}" to be rejected`)
  }
})

test('isValidLocalExtensionSlug rejects slugs starting with a non-alphanumeric', () => {
  for (const slug of ['.git', '-ext', '_ext', '.hidden']) {
    assert.equal(isValidLocalExtensionSlug(slug), false, `expected "${slug}" to be rejected`)
  }
})

test('isValidLocalExtensionSlug rejects whitespace and shell metacharacters', () => {
  for (const slug of ['my ext', 'ext;rm -rf', 'ext$(whoami)', 'ext`whoami`', 'ext|ls']) {
    assert.equal(isValidLocalExtensionSlug(slug), false, `expected "${slug}" to be rejected`)
  }
})

// ── resolveRemoteFilePath ───────────────────────────────────────────────────

test('resolveRemoteFilePath joins a relative path onto cwd', () => {
  assert.equal(
    resolveRemoteFilePath('server/git.ts', '/data/extensions/local/git'),
    '/data/extensions/local/git/server/git.ts',
  )
})

test('resolveRemoteFilePath leaves an absolute path unchanged even with a cwd', () => {
  assert.equal(resolveRemoteFilePath('/etc/passwd', '/data/extensions/local/git'), '/etc/passwd')
})

test('resolveRemoteFilePath leaves a relative path unchanged when there is no cwd', () => {
  assert.equal(resolveRemoteFilePath('server/git.ts', undefined), 'server/git.ts')
})

test('resolveRemoteFilePath normalizes "." segments when joining', () => {
  assert.equal(
    resolveRemoteFilePath('./server/git.ts', '/data/extensions/local/git'),
    '/data/extensions/local/git/server/git.ts',
  )
})

// ── buildLocalExtensionCtx (pure: existence check + ctx shape) ─────────────

test('buildLocalExtensionCtx returns a local ctx rooted at the extension folder for a known slug', () => {
  const ctx = buildLocalExtensionCtx('git', ['git', 'terraform'], '/data/extensions/local')
  assert.deepEqual(ctx, { type: 'local', cwd: path.join('/data/extensions/local', 'git') })
})

test('buildLocalExtensionCtx throws a clear error for an unknown slug', () => {
  assert.throws(
    () => buildLocalExtensionCtx('does-not-exist', ['git', 'terraform'], '/data/extensions/local'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /Unknown local extension: does-not-exist/)
      return true
    },
  )
})

// ── resolveTerminalContext: "extensions/<slug>" static handle input validation ─
// (Syntactic rejection happens before any I/O, so these run without the MCP/server runtime;
// the filesystem-backed happy path is covered indirectly via buildLocalExtensionCtx above plus
// manual verification against a real sandbox extension — see PR description.)

test('resolveTerminalContext rejects a traversal attempt in the extension handle before touching disk', async () => {
  await assert.rejects(resolveTerminalContext({ target: 'extensions/../../etc' }), (err: { message?: string }) => {
    assert.match(err.message ?? '', /Invalid local extension handle/)
    return true
  })
})

test('resolveTerminalContext rejects a slash-smuggling extension handle', async () => {
  // parseEndpoint splits on the FIRST "/", so "extensions/a/b" yields nodeId="extensions",
  // handle="a/b" — the slug validator must still reject the embedded separator.
  await assert.rejects(resolveTerminalContext({ target: 'extensions/a/b' }), (err: { message?: string }) => {
    assert.match(err.message ?? '', /Invalid local extension handle/)
    return true
  })
})

test('resolveTerminalContext rejects a bare "extensions" target with no handle', async () => {
  await assert.rejects(resolveTerminalContext({ target: 'extensions' }), (err: { message?: string }) => {
    assert.match(err.message ?? '', /target must include handle/)
    return true
  })
})

// ── remote search helpers (remote_glob / remote_grep) ──────────────────────

test('globPatternToEre spans directories only with **', () => {
  assert.equal(globPatternToEre('src/**/*.tsx'), '^src/.*/[^/]*\\.tsx$')
  assert.equal(globPatternToEre('*.ts'), '^[^/]*\\.ts$')
  assert.equal(globPatternToEre('a?c'), '^a[^/]c$')
})

test('globPatternToEre escapes regex metacharacters', () => {
  assert.equal(globPatternToEre('a+b(c)|d'), '^a\\+b\\(c\\)\\|d$')
})

test('insideExcludedDir matches whole path segments only', () => {
  assert.equal(insideExcludedDir('/app/node_modules/lodash'), true)
  assert.equal(insideExcludedDir('repo/dist'), true)
  assert.equal(insideExcludedDir('/app/src/components'), false)
  assert.equal(insideExcludedDir('/app/distributed/lib'), false)
})

test('capColumns leaves short lines alone and truncates long ones with a note', () => {
  assert.equal(capColumns('short'), 'short')
  const long = 'x'.repeat(700)
  const capped = capColumns(long)
  assert.equal(capped.startsWith('x'.repeat(500)), true)
  assert.match(capped, /\[\+200 chars\]$/)
})

// ── buildBase64WriteCommands (pre-existing helper — smoke test kept minimal) ─

test('buildBase64WriteCommands still round-trips an empty file (regression guard)', () => {
  assert.deepEqual(buildBase64WriteCommands('/tmp/x', ''), [": > '/tmp/x'"])
})

// ── replaceExact (remote_edit / edit_node_property) ─────────────────────────

test('replaceExact replaces a unique occurrence', () => {
  assert.equal(replaceExact('a b c', { oldString: 'b', newString: 'x', replaceAll: false }, 'file'), 'a x c')
})

test('replaceExact inserts $-substitution patterns literally (regression guard)', () => {
  const content = 'const re = /x/\nrest of file'
  const edit = { oldString: 'const re = /x/', newString: "match(/\\.tsx$/, '$&', `$'`, '$$1')", replaceAll: false }
  assert.equal(replaceExact(content, edit, 'file'), "match(/\\.tsx$/, '$&', `$'`, '$$1')\nrest of file")
})

test('replaceExact replaceAll keeps $ patterns literal in every occurrence', () => {
  assert.equal(replaceExact('a a', { oldString: 'a', newString: "$'", replaceAll: true }, 'file'), "$' $'")
})

test('replaceExact fails when oldString is missing or ambiguous', () => {
  assert.throws(
    () => replaceExact('a', { oldString: 'x', newString: 'y', replaceAll: false }, 'file'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /oldString not found in file/)
      return true
    },
  )
  assert.throws(
    () => replaceExact('a a', { oldString: 'a', newString: 'y', replaceAll: false }, 'property'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /not unique \(2 matches\)/)
      return true
    },
  )
})

// ── requireCallingAgent ────────────────────────────────────────────────────
//
// The gate every agent-acting tool rests on. The property worth pinning is not
// that it returns a name — it is that an unidentified caller is REFUSED rather
// than defaulted, because there is no safe default for "which agent is this".

test('requireCallingAgent returns the agent behind the credential', () => {
  assert.equal(requireCallingAgent({ agent: 'Agent Solo' }), 'Agent Solo')
})

test('requireCallingAgent refuses a caller the surface could not identify', () => {
  // Covers every way `agent` ends up null: no credential presented, a personal
  // token, auth switched off, and the in-process bridge — none of which say
  // WHICH agent is asking, so all of them are the same answer here.
  assert.throws(
    () => requireCallingAgent({ agent: null }),
    (e: unknown) => {
      const err = e as { message?: string }
      assert.match(String(err.message), /did not identify one/)
      return true
    },
  )
})

test('requireCallingAgent refuses an empty agent name as firmly as a missing one', () => {
  // An empty string is not a name. Letting it through would resolve to "no
  // agent node found" deeper in, which reads as a lookup failure rather than
  // as the credential problem it actually is.
  assert.throws(() => requireCallingAgent({ agent: '' }))
})
