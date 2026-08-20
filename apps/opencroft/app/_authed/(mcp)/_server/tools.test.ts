import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  buildAtomicReplaceCommand,
  buildBase64WriteCommands,
  buildCountedReadCommand,
  buildLocalExtensionCtx,
  buildTempWritePath,
  capColumns,
  extensionSlugFromTarget,
  globPatternToEre,
  insideExcludedDir,
  isValidLocalExtensionSlug,
  localSlugFromExtensionId,
  parseCountedRead,
  replaceExact,
  requireCallingAgent,
  resolveRemoteFilePath,
  resolveTerminalContext,
} from './tools'

// ── extensionSlugFromTarget / localSlugFromExtensionId ─────────────────────
//
// Which folder a call is about, decided before any lookup or filesystem access.
// Both answer null for anything that is not a local extension, so a guard built
// on them can never attach itself to an unrelated target.

test('extensionSlugFromTarget recognises the extension handle', () => {
  assert.equal(extensionSlugFromTarget('extensions/my-ext'), 'my-ext')
})

test('extensionSlugFromTarget ignores ordinary node targets', () => {
  for (const target of ['mynode_abc/terminal', 'extensions', '', undefined, null, 42]) {
    assert.equal(extensionSlugFromTarget(target), null, `expected ${String(target)} to be ignored`)
  }
})

test('extensionSlugFromTarget refuses a slug it would not accept as a path segment', () => {
  // The guard must not be reachable with a handle the path validation rejects.
  for (const target of ['extensions/../secrets', 'extensions/a b', 'extensions/.hidden']) {
    assert.equal(extensionSlugFromTarget(target), null, `expected "${target}" to be refused`)
  }
})

test('localSlugFromExtensionId accepts only the local scope', () => {
  assert.equal(localSlugFromExtensionId('local/my-ext'), 'my-ext')
  assert.equal(localSlugFromExtensionId('installed/my-ext'), null)
  assert.equal(localSlugFromExtensionId('builtin/core'), null)
  assert.equal(localSlugFromExtensionId('my-ext'), null)
  assert.equal(localSlugFromExtensionId(undefined), null)
})

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

// ── atomic remote writes ───────────────────────────────────────────────────
//
// A remote write assembles base64 chunks into a scratch file beside the target, verifies the
// byte count there, and only then renames it over the target. The chunk commands empty their
// destination with the first chunk and rebuild it with the rest, so the invariant worth holding
// on to is that the destination is never the file the caller means to keep.

test('buildBase64WriteCommands still round-trips an empty file (regression guard)', () => {
  assert.deepEqual(buildBase64WriteCommands('/tmp/x', ''), [": > '/tmp/x'"])
})

test('buildBase64WriteCommands truncates on the first chunk and appends on every later one', () => {
  // A small chunk size makes the split visible without building a megabyte of content.
  const commands = buildBase64WriteCommands('/w/.f.tok.tmp', 'abcdefghijkl', 4)
  assert.equal(commands.length, 4)
  assert.equal(commands[0].includes(" > '/w/.f.tok.tmp'"), true)
  assert.equal(
    commands.filter((command) => command.includes(" > '/w/.f.tok.tmp'")).length,
    1,
    'exactly one command may truncate, and it must be the first',
  )
  for (const command of commands.slice(1)) {
    assert.equal(command.includes(" >> '/w/.f.tok.tmp'"), true)
  }
})

test('buildBase64WriteCommands reconstructs the content byte-for-byte across a chunk boundary', () => {
  const content = 'héllo wörld — ünicode\n\ttabs and "quotes"\n'
  const commands = buildBase64WriteCommands('/w/scratch', content, 8)
  const encoded = commands
    .map((command) => /^printf '%s' '([^']*)' \| base64 -d >>? '\/w\/scratch'$/.exec(command)?.[1] ?? '')
    .join('')
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), content)
})

test('buildTempWritePath keeps the scratch file in the target directory', () => {
  // Same directory, so the replacing `mv` is a rename within one filesystem rather than a
  // cross-device copy — /tmp would reopen the very window this closes.
  assert.equal(buildTempWritePath('/app/src/index.ts', 'tok'), '/app/src/.index.ts.tok.tmp')
  assert.equal(buildTempWritePath('/tmp/run.sh', 'tok'), '/tmp/.run.sh.tok.tmp')
})

test('buildTempWritePath leaves a relative target relative, so it resolves against the same cwd', () => {
  assert.equal(buildTempWritePath('index.ts', 'tok'), '.index.ts.tok.tmp')
  assert.equal(buildTempWritePath('src/index.ts', 'tok'), 'src/.index.ts.tok.tmp')
})

test('buildAtomicReplaceCommand renames last, so the target survives every earlier failure', () => {
  const command = buildAtomicReplaceCommand('/app/.f.tok.tmp', '/app/f')
  assert.equal(command.split('; ').at(-1), `mv -f '/app/.f.tok.tmp' "$t"`)
  // Sequenced with ';' rather than '&&': a target that does not exist yet has no link to
  // resolve and no mode to copy, and must still be created.
  assert.equal(command.includes('&& mv'), false)
})

test('buildAtomicReplaceCommand resolves symlinks and carries the existing mode across', () => {
  const command = buildAtomicReplaceCommand('/app/.f.tok.tmp', '/app/f')
  assert.match(command, /r=\$\(readlink -f "\$t" 2>\/dev\/null\) && \[ -n "\$r" \] && t="\$r"/)
  assert.match(command, /m=\$\(stat -c %a "\$t" 2>\/dev\/null\) && chmod "\$m" '\/app\/\.f\.tok\.tmp'/)
})

test('buildAtomicReplaceCommand quotes paths that would otherwise break out of the shell', () => {
  const command = buildAtomicReplaceCommand("/app/.a b'c.tok.tmp", "/app/a b'c")
  assert.equal(command.startsWith(`t='/app/a b'\\''c'`), true)
  assert.equal(command.endsWith(`mv -f '/app/.a b'\\''c.tok.tmp' "$t"`), true)
})

// ── counted reads ──────────────────────────────────────────────────────────
//
// remote_edit rewrites whatever the read handed back, so a silently truncated read writes a
// shortened file and reports success. The byte count travels with the content so the two can be
// compared before anything is written.

test('buildCountedReadCommand asks for the byte count ahead of the content', () => {
  assert.equal(buildCountedReadCommand('/app/f.ts'), `wc -c < '/app/f.ts'; cat '/app/f.ts'`)
})

test('parseCountedRead returns the content when the count agrees', () => {
  assert.equal(parseCountedRead('5\nhello', '/app/f'), 'hello')
})

test('parseCountedRead handles an empty file and content that is itself full of newlines', () => {
  assert.equal(parseCountedRead('0\n', '/app/f'), '')
  assert.equal(parseCountedRead('12\na\nb\nc\nd\ne\nf\n', '/app/f'), 'a\nb\nc\nd\ne\nf\n')
})

test('parseCountedRead measures the content in bytes, not characters', () => {
  const content = 'héllo — wörld\n'
  assert.equal(parseCountedRead(`${Buffer.byteLength(content, 'utf8')}\n${content}`, '/app/f'), content)
})

test('parseCountedRead refuses a truncated read instead of handing back the fragment', () => {
  // What a byte-capped transport produces: the count describes the whole file, the content that
  // followed it does not.
  assert.throws(
    () => parseCountedRead('4096\nonly the first bytes arrived', '/app/f.ts'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /expected 4096 bytes, received 28/)
      assert.match(err.message ?? '', /Refusing to edit a partial read/)
      return true
    },
  )
})

test('parseCountedRead refuses a response carrying no byte count at all', () => {
  for (const output of ['not a number\ncontent', '']) {
    assert.throws(
      () => parseCountedRead(output, '/app/f'),
      (err: { message?: string }) => {
        assert.match(err.message ?? '', /reported no byte count/)
        return true
      },
      `expected ${JSON.stringify(output)} to be refused`,
    )
  }
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
  // token, auth switched off, and a bridged call whose session could not be
  // attributed to one agent — none of which say WHICH agent is asking, so all
  // of them are the same answer here.
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
