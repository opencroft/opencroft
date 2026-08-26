// Reading a test run's output and comparing it to what is tolerated. Kept
// apart from check-baseline.mjs, which runs the suite and decides an exit code,
// so this half can be exercised against output that never came from a real run
// -- including the shapes a real run is least likely to produce and most likely
// to be wrong about.
import path from 'node:path'

// A failure is identified by the file it lives in plus the name of the test: a
// name alone is not unique across a monorepo, and silently matching the wrong
// one would hide exactly what this looks for.
//
// A whole file that fails to load reports its own path as the test name, and
// reports it relative to its workspace while the location is absolute -- the
// same thing written two ways, so the id says it once. The comparison is on a
// path BOUNDARY, not a suffix: a test named `ts` is a suffix of every `.ts`
// file, and collapsing on that would give a real test failure the id reserved
// for its whole file failing to load, where a tolerated load failure would
// quietly absorb it.
export function identify(file, name) {
  return file === name || file.endsWith(`/${name}`) ? file : `${file} :: ${name}`
}

// Node's TAP output carries the absolute path of a failing test in the YAML
// block under it, which is the only place the file is available: the reporter's
// own `classname` is a constant, and the test name on its own does not say
// where it lives.
export function parseFailures(output, root) {
  const failures = []
  let reported = 0
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const total = lines[i].match(/^# fail (\d+)$/)
    if (total) {
      reported += Number(total[1])
      continue
    }
    // Only top-level entries. A failing subtest always fails its parent too, so
    // anchoring at column 0 loses no failure -- it reports the outermost name.
    const failed = lines[i].match(/^not ok \d+ - (.*)$/)
    if (!failed) {
      continue
    }
    let file = null
    // The first `location` in the block, not the last: the test's own comes
    // before `error`, and an error's text can carry a stack line shaped just
    // like one. Taking the last would point at whatever the failure touched
    // rather than at the test, which is a wrong id that still looks right.
    for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]); j += 1) {
      const where = lines[j].match(/^\s+location: '(.+?):\d+:\d+'$/)
      if (where) {
        file = path.relative(root, where[1])
        break
      }
    }
    const name = failed[1].trim()
    failures.push({ id: identify(file ?? '(unknown file)', name), file, name })
  }
  return { failures, reported }
}

export function compare(failures, known) {
  const knownIds = new Set(known.map((entry) => entry.id))
  const foundIds = new Set(failures.map((failure) => failure.id))
  return {
    added: failures.filter((failure) => !knownIds.has(failure.id)),
    stale: known.filter((entry) => !foundIds.has(entry.id)),
  }
}

// Whether the output can be believed at all, before anything is concluded from
// it. Every check here exists because its absence makes total failure look like
// success: a run that produced nothing has nothing to disagree with, so a
// comparison between two numbers both read out of that nothing agrees, reports
// no new failures, and advises deleting every tolerated entry as obsolete.
//
// Of the three output formats read here, one is ours: `Found N test files.`,
// printed by run-tests.mjs, which says there that it is consumed. TAP is a
// specified format. npm's `> pkg@version script` banner is neither -- but if it
// ever stops being printed, `started` collapses to zero and the first check
// below refuses the whole run rather than quietly reading fewer suites.
export function auditRun(output, status, extracted, reported, signal) {
  const count = (pattern) => (output.match(pattern) ?? []).length
  const started = count(/^> \S+@\S+ test$/gm)
  const listed = count(/^Found \d+ test files\.$/gm)
  const withFiles = count(/^Found [1-9]\d* test files\.$/gm)
  const totals = count(/^# fail \d+$/gm)

  // A killed run is the one partial run every check below agrees with: the
  // suites that finished each started, listed and totalled, and the failures
  // among them extract cleanly -- so a delta gets computed over however much
  // ran before the process died. Nothing in the output says it was cut short.
  // The signal is the only place that fact exists, and a run killed for memory
  // is not hypothetical on a machine that runs the whole suite at once.
  if (signal) {
    return `the run was killed by ${signal}, so its output describes only the part that finished`
  }
  if (started === 0) {
    return 'no workspace reported running its tests at all'
  }
  if (listed !== started) {
    return `${started} workspaces started their tests but ${listed} reported which files they found`
  }
  if (totals !== withFiles) {
    return `${withFiles} suites had test files but ${totals} reported totals`
  }
  if (extracted !== reported) {
    return `the suites reported ${reported} failures and ${extracted} were extracted`
  }
  if (status !== 0 && extracted === 0) {
    return `the run exited ${status} with no failure extracted from its output`
  }
  return null
}
