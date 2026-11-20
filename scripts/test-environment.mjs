// The environment every test file starts from: the variables listed below,
// taken from the caller's, and nothing else.
//
// A shell that starts a test run holds whatever its owner put there: a
// GIT_ASKPASS that answers with a forge token, credentials injected under
// names nobody can predict, a GIT_DIR left by a hook. Every test's `git`, child
// process and local server would see them, so a credential leaves the caller's
// process and a test can pass or fail for a reason the tree does not have. A
// list of what to drop cannot name what it has never seen, so this is a list
// of what to keep, each with the reason a test needs it.
//
// A suite that needs another variable from the caller adds it here with its
// reason. A variable a test sets for a child process it starts is the test's
// own and needs no entry.

/** Variables kept by exact name, each with why a test run needs it. */
export const KEPT_NAMES = {
  PATH: 'finds node, npm, git and the other binaries tests run',
  HOME: "npm's cache and tools that look up the user's directory",
  TMPDIR: 'where tests and the runner make scratch directories',
  TMP: 'the scratch directory under the name some tools read',
  TEMP: 'the scratch directory under the name some tools read',
  LANG: 'the locale that output and sorting are compared in',
  LANGUAGE: 'the locale that output and sorting are compared in',
  TZ: 'the time zone that formatted dates are compared in',
  TERM: 'what the reporter may draw when the run is on a terminal',
  CI: 'tools that behave differently when run by CI',
  FORCE_COLOR: 'whether the reporter colours its output',
  NO_COLOR: 'whether the reporter colours its output',
  NODE_OPTIONS: 'flags the caller gives node for the run, such as a larger heap',
  MEET: "the directory the runner's own tests coordinate their scratch runs through",
  MARKDOWN_ROUND_TRIP_CORPUS: "the opt-in markdown round-trip test's corpus directory",
}

/**
 * Variables kept by prefix, each with why a test run needs them. A prefix
 * keeps every name under it, so one is listed only where nothing under it
 * holds a credential. NODE_ and npm_ are not: NODE_AUTH_TOKEN is a registry
 * token, and npm carries every .npmrc key in the environment as
 * `npm_config_<key>`, auth tokens included. No test reads npm's script
 * context, and an `npm` a test starts reads its configuration from HOME.
 * NODE_TEST_CONTEXT, which marks a file as part of a run, is set by node's
 * test runner on each file it starts.
 */
export const KEPT_PREFIXES = {
  LC_: 'the locale that output and sorting are compared in',
  OPENCROFT_TEST_: "this runner's own settings: concurrency, slots, limits, report format",
}

/** The variables of `inherited` a test file may see. */
export function testEnvironment(inherited) {
  const prefixes = Object.keys(KEPT_PREFIXES)
  const kept = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue
    if (Object.hasOwn(KEPT_NAMES, name) || prefixes.some((prefix) => name.startsWith(prefix))) {
      kept[name] = value
    }
  }
  return kept
}
