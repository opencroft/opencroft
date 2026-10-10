// The lint verdict: biome over every file of the repository, with nothing
// tolerated. Every finding fails, whatever its severity, in whichever file it
// sits, so nothing old can hide behind a change that did not touch it.
//
// It runs over every file git knows about (tracked, or untracked and not
// ignored), minus the files an install writes (installed.mjs), minus whatever
// the repository's biome config excludes.
//
// WHAT IT REFUSES TO BELIEVE
//
// `biome check` on a path that does not exist exits 1, the same code a healthy
// run with findings returns, so the exit code cannot tell whether biome ran.
// Every believability check lives in readRun() instead: unreadable JSON, a
// missing summary, zero files scanned, withheld diagnostics and diagnostics
// with no file or rule all fail the check rather than pass it. "Nothing found"
// and "nothing ran" do not share an answer.

import { runBiome } from './biome.mjs'
import { partitionInstalled } from './installed.mjs'
import { allFiles } from './repo.mjs'

/**
 * Whether a biome JSON report can be believed, and the findings in it.
 *
 * `diagnosticsNotPrinted` is the quiet one: biome caps printed diagnostics in
 * some invocations, and a capped run produces a smaller, entirely well-formed
 * list of findings.
 *
 * Returns `{ ok: true, scanned, findings }` or `{ ok: false, reason }`. Each
 * finding is `{ file, line, column, rule, message }`, sorted by place.
 */
export function readRun(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'biome produced no readable JSON' }
  }
  if (!parsed.summary || typeof parsed.summary !== 'object') {
    return { ok: false, reason: 'biome output carried no summary' }
  }
  if (!Array.isArray(parsed.diagnostics)) {
    return { ok: false, reason: 'biome output carried no diagnostics array' }
  }
  const summary = parsed.summary
  const scanned = (summary.changed ?? 0) + (summary.unchanged ?? 0)
  if (scanned <= 0) {
    return { ok: false, reason: 'biome scanned no files: it ran, and looked at nothing' }
  }
  if ((summary.diagnosticsNotPrinted ?? 0) > 0) {
    return {
      ok: false,
      reason: `biome withheld ${summary.diagnosticsNotPrinted} diagnostics, so the list is truncated`,
    }
  }
  const findings = []
  let unreadable = 0
  for (const d of parsed.diagnostics) {
    const file = typeof d?.location?.path === 'string' ? d.location.path : null
    const rule = typeof d?.category === 'string' ? d.category : null
    if (!file || !rule) {
      unreadable += 1
      continue
    }
    // A formatting finding is about the whole file: biome gives it no position,
    // or line 0 (its lines count from 1).
    const placed = d.location.start?.line > 0
    findings.push({
      file,
      line: placed ? d.location.start.line : null,
      column: placed ? d.location.start.column : null,
      rule,
      message: typeof d.message === 'string' ? d.message : '',
    })
  }
  // A diagnostic that cannot be placed is counted rather than skipped: dropping
  // it would turn a finding into a clean result with no trace of why.
  if (unreadable > 0) {
    return { ok: false, reason: `${unreadable} diagnostic(s) carried no file or rule and could not be reported` }
  }
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  )
  return { ok: true, scanned, findings }
}

/** Returns `{ code, scanned, findings }`: code 0 clean, 1 findings, 2 the run could not be believed. */
export function lint(root) {
  const { own } = partitionInstalled(root, allFiles(root))
  // `--max-diagnostics=none` rather than trusting the reporter's default, which
  // would truncate the list into a well-formed, shorter, wrong one if it ever
  // started capping.
  const run = runBiome(root, own, ['--reporter=json', '--max-diagnostics=none'])
  if (run.error) {
    return { code: 2, reason: `could not run biome: ${run.error.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(run.stdout)
  } catch (err) {
    const said = run.stderr.trim().split('\n').slice(0, 5).join('\n')
    return { code: 2, reason: `biome's JSON could not be parsed: ${err.message}${said ? `\n${said}` : ''}` }
  }
  const verdict = readRun(parsed)
  if (!verdict.ok) {
    return { code: 2, reason: verdict.reason }
  }
  return { code: verdict.findings.length > 0 ? 1 : 0, scanned: verdict.scanned, findings: verdict.findings }
}
