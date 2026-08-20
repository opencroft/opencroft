import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildAtomicReplaceCommand,
  buildBase64WriteCommands,
  buildCountedReadCommand,
  buildLocalExtensionCtx,
  buildResolveTargetCommand,
  buildScratchInitCommand,
  buildTempWritePath,
  capColumns,
  extensionSlugFromTarget,
  globPatternToEre,
  insideExcludedDir,
  isValidLocalExtensionSlug,
  localSlugFromExtensionId,
  parseCountedRead,
  parseResolveTarget,
  replaceExact,
  requireCallingAgent,
  resolveRemoteFilePath,
  resolveTerminalContext,
  writeFileExactWith,
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

test('buildTempWritePath keeps the scratch file in the resolved target directory', () => {
  // Same directory as the file the rename actually lands on, so the replace is a rename within
  // one filesystem rather than a cross-device copy.
  assert.equal(buildTempWritePath('/app/src/index.ts', 'tok'), '/app/src/.index.ts.tok.tmp')
  assert.equal(buildTempWritePath('/tmp/run.sh', 'tok'), '/tmp/.run.sh.tok.tmp')
})

test('buildTempWritePath leaves a relative target relative, so it resolves against the same cwd', () => {
  assert.equal(buildTempWritePath('index.ts', 'tok'), '.index.ts.tok.tmp')
  assert.equal(buildTempWritePath('src/index.ts', 'tok'), 'src/.index.ts.tok.tmp')
})

test('buildScratchInitCommand sets the mode before content can land, and stops if it cannot', () => {
  // '&&' not ';': a chmod that fails must not go on to have content written at the wrong mode
  // and then renamed over the target — that is the silent 0755 -> 0644 downgrade.
  assert.equal(
    buildScratchInitCommand('/app/.f.tok.tmp', '755'),
    `: > '/app/.f.tok.tmp' && chmod '755' '/app/.f.tok.tmp'`,
  )
  assert.equal(buildScratchInitCommand('/app/.f.tok.tmp', null), `: > '/app/.f.tok.tmp'`)
})

test('buildAtomicReplaceCommand is a bare rename of scratch onto target', () => {
  // Resolution and mode now happen earlier, so nothing here can silently degrade.
  assert.equal(buildAtomicReplaceCommand('/app/.f.tok.tmp', '/app/f'), `mv -f '/app/.f.tok.tmp' '/app/f'`)
})

test('buildAtomicReplaceCommand quotes paths that would otherwise break out of the shell', () => {
  assert.equal(
    buildAtomicReplaceCommand("/app/.a b'c.tok.tmp", "/app/a b'c"),
    `mv -f '/app/.a b'\\''c.tok.tmp' '/app/a b'\\''c'`,
  )
})

// ── the pre-write probe ────────────────────────────────────────────────────
//
// `readlink -f` and `stat -c` are GNU. On a remote without them both substitutions come back
// empty, and the difference between "no such file" and "this remote cannot answer" is the
// difference between creating a file and silently resetting an existing one's mode. So the probe
// reports every field unconditionally and the parser refuses anything it cannot read.

test('parseResolveTarget reads a resolved symlink and its mode', () => {
  const probe = 'link=1\nresolved=/real/data\nexists=1\nmode=644\nok=1\n'
  assert.deepEqual(parseResolveTarget(probe, '/links/data'), { path: '/real/data', mode: '644' })
})

test('parseResolveTarget reports a missing target as a create with no mode to carry', () => {
  const probe = 'link=0\nresolved=/app/new\nexists=0\nmode=\nok=1\n'
  assert.deepEqual(parseResolveTarget(probe, '/app/new'), { path: '/app/new', mode: null })
})

test('parseResolveTarget refuses a symlink this remote cannot resolve', () => {
  // Rather than replacing the link itself with a regular file.
  assert.throws(
    () => parseResolveTarget('link=1\nresolved=\nexists=1\nmode=644\nok=1\n', '/links/data'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /symlink and this remote has no working `readlink -f`/)
      return true
    },
  )
})

test('parseResolveTarget refuses an existing target whose mode it cannot read', () => {
  for (const mode of ['', 'rw-r--r--', '9999']) {
    assert.throws(
      () => parseResolveTarget(`link=0\nresolved=/app/f\nexists=1\nmode=${mode}\nok=1\n`, '/app/f'),
      (err: { message?: string }) => {
        assert.match(err.message ?? '', /no usable file mode/)
        return true
      },
      `expected mode ${JSON.stringify(mode)} to be refused`,
    )
  }
})

test('parseResolveTarget refuses a probe that did not run to completion', () => {
  assert.throws(
    () => parseResolveTarget('link=0\nresolved=/app/f\nexists=1\nmode=644\n', '/app/f'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /did not complete the pre-write probe/)
      return true
    },
  )
})

test('buildResolveTargetCommand reports link, resolution, existence and mode in one round trip', () => {
  const command = buildResolveTargetCommand('/app/f')
  assert.match(command, /^t='\/app\/f'; /)
  assert.match(command, /if \[ -L "\$t" \]/)
  assert.match(command, /readlink -f "\$t" 2>\/dev\/null \|\| true/)
  assert.match(command, /stat -c %a "\$t" 2>\/dev\/null \|\| true/)
  assert.match(command, /ok=1/)
})

// ── write orchestration ────────────────────────────────────────────────────
//
// The ordering is the fix, so it is asserted directly: with the exec channel injected, every
// command the write issues is recorded and checked. A string-shape test cannot see an ordering
// mistake, and this is where the original bug lived.

/** Probe response for an ordinary existing file, so orchestration tests need no shell. */
const EXISTING_FILE_PROBE = 'link=0\nresolved=/w/f\nexists=1\nmode=644\nok=1\n'

test('nothing touches the target until a verified scratch file is renamed over it', async () => {
  const log: string[] = []
  await writeFileExactWith(
    async (command) => {
      log.push(command)
      if (command.startsWith('t=')) return EXISTING_FILE_PROBE
      if (command.startsWith('wc -c')) return '5\n'
      return ''
    },
    '/w/f',
    'hello',
    'tok',
  )
  const rename = log.findIndex((command) => command.startsWith('mv -f'))
  assert.equal(rename, log.length - 1, 'the rename must be the last thing that happens')
  assert.equal(log[rename], `mv -f '/w/.f.tok.tmp' '/w/f'`)
  for (const command of log.slice(0, rename)) {
    assert.equal(/> '\/w\/f'/.test(command), false, `nothing may redirect into the target: ${command}`)
  }
  assert.equal(
    log.some((command) => command.includes(`chmod '644' '/w/.f.tok.tmp'`)),
    true,
    "the target's mode is carried onto the scratch file",
  )
})

test('the scratch file takes the mode before any content is written into it', async () => {
  // Otherwise a 0600 file's contents sit at the umask default for the whole write.
  const log: string[] = []
  await writeFileExactWith(
    async (command) => {
      log.push(command)
      if (command.startsWith('t=')) return 'link=0\nresolved=/w/f\nexists=1\nmode=600\nok=1\n'
      if (command.startsWith('wc -c')) return '5\n'
      return ''
    },
    '/w/f',
    'hello',
    'tok',
  )
  const firstContent = log.find((command) => command.includes('base64 -d'))
  assert.ok(firstContent, 'expected a chunk command')
  assert.equal(
    firstContent.indexOf('chmod') >= 0 && firstContent.indexOf('chmod') < firstContent.indexOf('base64 -d'),
    true,
    'the chmod must precede the first content in the same command',
  )
})

test('a chmod that fails stops the write before the rename and cleans up', async () => {
  const log: string[] = []
  await assert.rejects(() =>
    writeFileExactWith(
      async (command) => {
        log.push(command)
        if (command.startsWith('t=')) return EXISTING_FILE_PROBE
        if (command.includes('chmod')) throw new Error('Command exited with code 1')
        return ''
      },
      '/w/f',
      'hello',
      'tok',
    ),
  )
  assert.equal(
    log.some((command) => command.startsWith('mv -f')),
    false,
    'the target must never be renamed over',
  )
  assert.equal(
    log.some((command) => command === `rm -f '/w/.f.tok.tmp'`),
    true,
    'the scratch file is cleaned up',
  )
})

test('a byte-count mismatch refuses the rename and cleans up', async () => {
  const log: string[] = []
  await assert.rejects(
    () =>
      writeFileExactWith(
        async (command) => {
          log.push(command)
          if (command.startsWith('t=')) return EXISTING_FILE_PROBE
          if (command.startsWith('wc -c')) return '3\n'
          return ''
        },
        '/w/f',
        'hello',
        'tok',
      ),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /expected 5 bytes, remote reports 3/)
      return true
    },
  )
  assert.equal(
    log.some((command) => command.startsWith('mv -f')),
    false,
  )
  assert.equal(
    log.some((command) => command === `rm -f '/w/.f.tok.tmp'`),
    true,
  )
})

test('a probe that refuses the write issues no commands beyond the probe itself', async () => {
  const log: string[] = []
  await assert.rejects(() =>
    writeFileExactWith(
      async (command) => {
        log.push(command)
        return 'link=1\nresolved=\nexists=1\nmode=644\nok=1\n'
      },
      '/links/data',
      'hello',
      'tok',
    ),
  )
  assert.equal(log.length, 1, 'nothing may be created before the target is understood')
})

// ── write against a real filesystem ────────────────────────────────────────
//
// The tests above pin command strings and ordering; these run the commands the write actually
// issues through a real shell against real files, symlinks and hard links. That is the only way
// to catch a wrong assumption about what readlink, stat, chmod and mv do.

function withTempDir(run: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'remote-write-'))
    try {
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Runs each command for real, recording it, so a test can assert on both shell and paths. */
function shellExec(log: string[]): (command: string) => Promise<string> {
  return async (command) => {
    log.push(command)
    return execFileSync('bash', ['-c', command], { encoding: 'utf8' })
  }
}

test(
  'the scratch file is placed beside the resolved file, not beside the symlink naming it',
  withTempDir(async (dir) => {
    // The case the rename step exists to support. Placing the scratch beside the link would put
    // it on another filesystem whenever the link crosses a mount, where `mv` stops being atomic.
    const real = path.join(dir, 'real')
    const links = path.join(dir, 'links')
    mkdirSync(real)
    mkdirSync(links)
    writeFileSync(path.join(real, 'data'), 'OLD\n')
    symlinkSync(path.join(real, 'data'), path.join(links, 'link'))

    const log: string[] = []
    await writeFileExactWith(shellExec(log), path.join(links, 'link'), 'NEW\n', 'tok')

    assert.equal(
      log.some((command) => command.includes(`${real}/.data.tok.tmp`)),
      true,
      'the scratch file belongs beside the resolved file',
    )
    assert.equal(
      log.some((command) => command.includes(`${links}/.link.tok.tmp`)),
      false,
      'never beside the symlink',
    )
    assert.equal(readFileSync(path.join(real, 'data'), 'utf8'), 'NEW\n', 'written through the link')
    assert.equal(lstatSync(path.join(links, 'link')).isSymbolicLink(), true, 'the link survives as a link')
  }),
)

test(
  'an executable target is still executable afterwards',
  withTempDir(async (dir) => {
    const target = path.join(dir, 'script.sh')
    writeFileSync(target, '#!/bin/sh\necho old\n')
    chmodSync(target, 0o755)
    await writeFileExactWith(shellExec([]), target, '#!/bin/sh\necho new\n', 'tok')
    assert.equal(statSync(target).mode & 0o777, 0o755)
    assert.equal(execFileSync(target, { encoding: 'utf8' }).trim(), 'new')
  }),
)

test(
  'a restrictive mode is never widened, even briefly, while the content is being written',
  withTempDir(async (dir) => {
    const target = path.join(dir, 'secret')
    writeFileSync(target, 'old secret\n')
    chmodSync(target, 0o600)
    const modesSeen: number[] = []
    const scratch = path.join(dir, '.secret.tok.tmp')
    const log: string[] = []
    const exec = shellExec(log)
    await writeFileExactWith(
      async (command) => {
        const out = await exec(command)
        try {
          modesSeen.push(statSync(scratch).mode & 0o777)
        } catch {
          /* the scratch file does not exist before it is created or after it is renamed */
        }
        return out
      },
      target,
      'new secret\n',
      'tok',
    )
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.ok(modesSeen.length > 0, 'expected to observe the scratch file at least once')
    assert.deepEqual([...new Set(modesSeen)], [0o600], 'the scratch file was never readable by anyone else')
  }),
)

test(
  'a new file is created when the target does not exist yet',
  withTempDir(async (dir) => {
    const target = path.join(dir, 'fresh')
    await writeFileExactWith(shellExec([]), target, 'FRESH\n', 'tok')
    assert.equal(readFileSync(target, 'utf8'), 'FRESH\n')
    assert.deepEqual(readdirSync(dir), ['fresh'], 'no scratch file left behind')
  }),
)

test(
  'content is reconstructed byte-for-byte across several chunks',
  withTempDir(async (dir) => {
    const target = path.join(dir, 'big.txt')
    // Comfortably more than one 48 KB base64 chunk (36864 decoded bytes), with multibyte
    // characters landing across the boundary.
    const content = `${'ü'.repeat(40_000)}\ntail\n`
    await writeFileExactWith(shellExec([]), target, content, 'tok')
    assert.equal(readFileSync(target, 'utf8'), content)
  }),
)

test(
  'a failure part-way through the chunks leaves the target byte-identical and no scratch behind',
  withTempDir(async (dir) => {
    const target = path.join(dir, 'f')
    const original = 'ORIGINAL CONTENT\n'
    writeFileSync(target, original)
    let chunks = 0
    await assert.rejects(() =>
      writeFileExactWith(
        async (command) => {
          if (command.includes('base64 -d')) {
            chunks += 1
            if (chunks === 2) {
              throw new Error('Command exited with code 1')
            }
          }
          return execFileSync('bash', ['-c', command], { encoding: 'utf8' })
        },
        target,
        'x'.repeat(200_000),
        'tok',
      ),
    )
    assert.equal(readFileSync(target, 'utf8'), original, 'the original must be untouched')
    assert.deepEqual(readdirSync(dir), ['f'], 'the scratch file is cleaned up')
  }),
)

test(
  'a hard-linked target is replaced rather than written through — the documented trade',
  withTempDir(async (dir) => {
    // Not a bug: writing through a shared inode would silently mutate every other path pointing
    // at it. Asserted so the behaviour cannot change without someone deciding to change it.
    const target = path.join(dir, 'a')
    const other = path.join(dir, 'b')
    writeFileSync(target, 'OLD\n')
    linkSync(target, other)
    assert.equal(statSync(target).nlink, 2)

    await writeFileExactWith(shellExec([]), target, 'NEW\n', 'tok')

    assert.equal(readFileSync(target, 'utf8'), 'NEW\n')
    assert.equal(readFileSync(other, 'utf8'), 'OLD\n', 'the other link keeps the old content')
    assert.equal(statSync(target).nlink, 1)
  }),
)

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
  // 14 characters, 18 bytes — both counts written out rather than computed, so this cannot agree
  // with the implementation by using the same call it does.
  const content = 'héllo — wörld\n'
  assert.equal(content.length, 14)
  assert.equal(parseCountedRead(`18\n${content}`, '/app/f'), content)
  assert.throws(
    () => parseCountedRead(`14\n${content}`, '/app/f'),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /expected 14 bytes, received 18/)
      return true
    },
  )
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
