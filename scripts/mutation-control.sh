#!/usr/bin/env bash
# One mutation control: does a test file catch a defect written as a patch?
#
#   scripts/mutation-control.sh <patch-file> <test-file> [log]
#
# 1. Refuses (exit 3) when a file the patch touches has uncommitted changes,
#    or when the patch does not apply.
# 2. Runs the test file once unchanged. It has to be green, or the row is
#    INCONCLUSIVE: a red file catches every mutant.
# 3. Applies the patch, runs the same command again, reverses the patch and
#    checks that the touched files are back to HEAD.
# 4. Prints one verdict line (stdout for CAUGHT, stderr for the others) and
#    appends it to the log (default /tmp/mutation-<branch>.log):
#
#      <time> <VERDICT> patch=<name> test=<file> failed="<tests>" reason=<why> secs=<n>
#
#    CAUGHT        exit 0  at least one test failed and none was cancelled
#    SURVIVED      exit 1  every test passed
#    INCONCLUSIVE  exit 2  reason= says which:
#                          baseline-red      the unchanged file is not green
#                          baseline-timeout  the unchanged file hit the bound
#                          timeout           the mutant run hit the bound
#                          cancelled         a test was cancelled (it hung)
#                          no-report, exit-N no test report could be read
#
#    The verdict comes from the test report, never from the exit code alone.
#    `failed` names the failing tests ("suite > test"); check it is the test
#    you predicted. The last run's raw reports are kept beside the log in
#    <log without .log>.last/.
#
# The file runs the way scripts/run-tests.mjs runs it: from its workspace
# directory, with that workspace's tsconfig.test.json and
# scripts/test-setup.mjs preload when they exist, and the same test secrets.
#
# Time bound: OPENCROFT_MUTATION_CONTROL_TIMEOUT seconds per run (default 30;
# a control is two runs), enforced by `timeout`. Node's own --test-timeout is
# set 5 s below it, so a hung test usually ends with a report that counts it
# as cancelled. On Node 22 that flag bounds the whole file as well as each
# test, so it cannot be set lower than the time a healthy file needs.
# --test-force-exit ends a file whose tests finished but left a handle open.
# Every process the run started is killed when it ends.
#
# Exit 3 is a refused or broken setup; exit 4 means the source could not be
# restored, and the touched files need a look before anything else.

set -uo pipefail

die() {
  echo "mutation-control: $*" >&2
  exit 3
}

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  die "usage: scripts/mutation-control.sh <patch-file> <test-file> [log]"
fi

limit=${OPENCROFT_MUTATION_CONTROL_TIMEOUT:-30}
case $limit in
  '' | *[!0-9]*) die "OPENCROFT_MUTATION_CONTROL_TIMEOUT must be whole seconds, got '$limit'" ;;
esac
[ "$limit" -ge 10 ] || die "OPENCROFT_MUTATION_CONTROL_TIMEOUT must be at least 10 seconds"
test_timeout_ms=$(((limit - 5) * 1000))

patch=$(realpath -e -- "$1" 2>/dev/null) || die "no patch file at $1"
test_file=$(realpath -e -- "$2" 2>/dev/null) || die "no test file at $2"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run it inside a git checkout"
case $test_file in
  "$top"/*) ;;
  *) die "$2 is outside the checkout $top" ;;
esac
test_rel=${test_file#"$top"/}

branch=$(git -C "$top" rev-parse --abbrev-ref HEAD)
log=$(realpath -m -- "${3:-/tmp/mutation-${branch//\//-}.log}")
last_dir=${log%.log}.last

tsx=$top/node_modules/.bin/tsx
[ -x "$tsx" ] || die "no $tsx: install the checkout's dependencies first"

# The test file's workspace: the nearest directory above it with a
# package.json, as npm would run that workspace's test script.
ws=$(dirname "$test_file")
while [ "$ws" != "$top" ] && [ ! -f "$ws/package.json" ]; do
  ws=$(dirname "$ws")
done

# One control at a time per checkout: two would apply patches over each
# other. The lock goes with the process, so a killed run never leaves it held.
exec 9>"$(git -C "$top" rev-parse --absolute-git-dir)/mutation-control.lock"
flock -n 9 || die "another control is running in this checkout"

touched=()
while IFS=$'\t' read -r _added _deleted path; do
  [ -n "$path" ] || continue
  case $path in
    *' => '*) die "the patch renames $path; write the mutant as an edit" ;;
  esac
  touched+=("$path")
done < <(git -C "$top" apply --numstat "$patch" 2>/dev/null)
[ ${#touched[@]} -gt 0 ] || die "the patch touches no file, or cannot be read: $1"

dirty=$(git -C "$top" status --porcelain -- "${touched[@]}")
[ -z "$dirty" ] || die "uncommitted changes in files the patch touches:
$dirty"
git -C "$top" apply --check "$patch" 2>/dev/null || die "the patch does not apply to the checkout: $1"

mkdir -p "$last_dir" || die "cannot create $last_dir"

applied=0
restore() {
  if [ "$applied" = 1 ]; then
    if git -C "$top" apply -R "$patch"; then
      applied=0
    else
      echo "mutation-control: reversing $patch failed; check ${touched[*]}" >&2
      return 1
    fi
  fi
}
trap 'restore' EXIT
trap 'exit 130' INT TERM HUP

# Runs the test file once; the TAP report goes to $1.tap, everything else
# the process prints to $1.out. Echoes the exit code.
run_tests() {
  local preload=() tsconfig=()
  [ -f "$ws/scripts/test-setup.mjs" ] && preload=(--import ./scripts/test-setup.mjs)
  [ -f "$ws/tsconfig.test.json" ] && tsconfig=(TSX_TSCONFIG_PATH="$ws/tsconfig.test.json")
  rm -f "$1.tap" "$1.out"
  (
    cd "$ws" || exit 3
    env -u TSX_TSCONFIG_PATH -u OPENCROFT_PGLITE_PATH -u PGLITE_PATH \
      -u BETTER_AUTH_SECRET -u SECRETS_KEY -u NODE_TEST_CONTEXT \
      OPENCROFT_AUTH_SECRET=test-auth-secret-not-a-real-one \
      OPENCROFT_SECRETS_KEY=test-secrets-key-not-a-real-one \
      "${tsconfig[@]}" \
      timeout -k 5 "$limit" "$tsx" "${preload[@]}" --test \
      --test-timeout="$test_timeout_ms" --test-force-exit \
      --test-reporter=tap --test-reporter-destination="$1.tap" \
      "$test_file" &
    pid=$!
    wait "$pid"
    rc=$?
    # `timeout` leads a process group of its own (pgid = its pid). When the
    # runner cancels a test stuck in synchronous code, it reports and exits
    # while the file's process keeps spinning, and `timeout` only signals the
    # group when its own limit passes. End whatever is left of the run here.
    kill -KILL -- "-$pid" 2>/dev/null
    exit "$rc"
  ) </dev/null >"$1.out" 2>&1 9>&-
  echo $?
}

# Reads a TAP report. Prints "<tests> <pass> <fail> <cancelled>" and then,
# tab-separated, the failing tests: those that failed themselves, not a suite
# failing because of them, and not one cancelled by a timeout. Counts are -1
# when the report has no summary.
read_report() {
  node -e '
    const fs = require("node:fs")
    const text = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8") : ""
    const lines = text.split("\n")
    const counts = { tests: -1, pass: -1, fail: -1, cancelled: -1 }
    const path = []
    const failed = []
    const notFailures = new Set(["subtestsFailed", "cancelledByParent", "testTimeoutFailure"])
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let m = line.match(/^( *)# Subtest: (.*)$/)
      if (m) {
        const depth = m[1].length / 4
        path.length = depth
        path[depth] = m[2]
        continue
      }
      m = line.match(/^( *)not ok \d+ - (.*?)(?: # (?:TODO|SKIP)\b.*)?$/)
      if (m) {
        if (/ # (?:TODO|SKIP)\b/.test(line)) continue
        const depth = m[1].length / 4
        let type = ""
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j].trim()
          if (t === "...") break
          const f = t.match(/^failureType: .(\w+).$/)
          if (f) { type = f[1]; break }
        }
        if (!notFailures.has(type)) failed.push([...path.slice(0, depth), m[2]].join(" > "))
        continue
      }
      m = line.match(/^# (tests|pass|fail|cancelled) (\d+)$/)
      if (m) counts[m[1]] = Number(m[2])
    }
    const names = failed.map((n) => n.replace(/"/g, "\x27").replace(/\s+/g, " "))
    console.log(`${counts.tests} ${counts.pass} ${counts.fail} ${counts.cancelled}\t${names.join("; ")}`)
  ' "$1"
}

started=$(date +%s)
verdict=INCONCLUSIVE
reason=-
failed_names=

base_rc=$(run_tests "$last_dir/baseline")
IFS=$'\t' read -r base_counts _ < <(read_report "$last_dir/baseline.tap")
read -r b_tests _b_pass b_fail b_cancelled <<<"$base_counts"

if [ "$base_rc" = 124 ] || [ "$base_rc" = 137 ] || [ "$b_cancelled" -gt 0 ]; then
  reason=baseline-timeout
elif [ "$b_tests" -le 0 ] || [ "$b_fail" != 0 ] || [ "$b_cancelled" != 0 ] || [ "$base_rc" != 0 ]; then
  reason=baseline-red
else
  git -C "$top" apply "$patch" || die "the patch did not apply: $1"
  applied=1
  mut_rc=$(run_tests "$last_dir/mutant")
  restore || exit 4
  IFS=$'\t' read -r mut_counts failed_names < <(read_report "$last_dir/mutant.tap")
  read -r m_tests _m_pass m_fail m_cancelled <<<"$mut_counts"

  if [ "$mut_rc" = 124 ] || [ "$mut_rc" = 137 ]; then
    reason=timeout
  elif [ "$m_cancelled" -gt 0 ]; then
    reason=cancelled
  elif [ "$m_tests" -le 0 ]; then
    reason=no-report
  elif [ "$m_fail" -gt 0 ]; then
    verdict=CAUGHT
  elif [ "$mut_rc" = 0 ]; then
    verdict=SURVIVED
  else
    reason=exit-$mut_rc
  fi
fi

if [ -n "$(git -C "$top" status --porcelain -- "${touched[@]}")" ]; then
  echo "mutation-control: ${touched[*]} differ from HEAD after the control" >&2
  exit 4
fi

row="$(date -u +%FT%TZ) $verdict patch=$(basename "$patch") test=$test_rel failed=\"$failed_names\" reason=$reason secs=$(($(date +%s) - started))"
echo "$row" >>"$log"

# On stdout for exit 0 and on stderr otherwise: a caller that keeps only
# stderr from a failed command, or only stdout from a successful one, still
# sees the row, and a terminal shows it once.
case $verdict in
  CAUGHT)
    echo "$row"
    exit 0
    ;;
  SURVIVED)
    echo "$row" >&2
    exit 1
    ;;
  *)
    echo "$row" >&2
    exit 2
    ;;
esac
