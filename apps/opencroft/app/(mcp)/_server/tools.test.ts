import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  buildBase64WriteCommands,
  buildLocalExtensionCtx,
  isValidLocalExtensionSlug,
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

// ── buildBase64WriteCommands (pre-existing helper — smoke test kept minimal) ─

test('buildBase64WriteCommands still round-trips an empty file (regression guard)', () => {
  assert.deepEqual(buildBase64WriteCommands('/tmp/x', ''), [": > '/tmp/x'"])
})
