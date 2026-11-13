/**
 * Files on the machine a terminal context reaches, moved as raw bytes over the context's own exec
 * channel: the bytes are a command's stdin on the way in and its stdout on the way out. Every
 * transport has that channel (local, wsl, ssh, and docker-exec over any of them), and nothing is
 * encoded or put in a command line, so a file's size costs only its transfer. Measured on 50 MiB
 * (2026-10-30): under 0.25 s through local, ssh and docker-exec, against about 14 s locally for
 * the same bytes sent as base64 in shell commands.
 */
import type { ExecResult, TerminalContext } from '../types'
import { getBackend } from './backend'

/**
 * The largest file `readTerminalFile` reads unless told otherwise. The file is held in memory
 * whole, so this bounds one read's share of the server's memory; it is well past the images and
 * audio the pipelines read.
 */
export const MAX_FILE_BYTES = 256 * 1024 * 1024

// A transfer runs for as long as its bytes take, which over a slow link is longer than a command's
// default two minutes.
const FILE_TIMEOUT_MS = 10 * 60_000

/** What a write does when its path is taken: overwrite the file, fail, or add a number to the name. */
export type IfExists = 'overwrite' | 'fail' | 'number'

/** Where an `ifExists: 'number'` write puts the number: `photo.png`, then `photo-1.png`, `photo-2.png`. */
export const NUMBER_SEPARATOR = '-'

// The highest number a write tries before it gives up: a folder holding this many copies of one
// name is a template that wants a counter, not more tries.
const MAX_NUMBER = 9999

// Exit statuses of the write script that stand for a refusal rather than a failure.
const EXISTS = 17
const NO_FREE_NUMBER = 18
const IS_FOLDER = 19

/**
 * Writes stdin to a temp file beside the target, then moves it into place, so a reader never sees
 * half a file and a failed transfer leaves the target as it was. `fail` and `number` place it with
 * `ln`, which creates the name only when it is free, in one step, so two writes racing for one name
 * cannot both take it.
 *
 * A folder at the name takes it too: `ln` and `mv` given a folder put the file inside it under the
 * temp name, so `placed` checks for a folder after the step, takes that file back out, and reports
 * the name as taken. Checking after rather than before also covers a folder made in between.
 *
 * mktemp creates the temp file readable by its owner only; it is given the mode a new file would
 * have under the shell's umask before it takes the target's name.
 */
const WRITE_SCRIPT = `set -e
target=$1 mode=$2 stem=$3 ext=$4
dir=$(dirname -- "$target")
mkdir -p -- "$dir"
tmp=$(mktemp "$dir/.opencroft-write.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
chmod "$(printf '%o' $((0666 & ~$(umask))))" "$tmp"
placed() {
  [ -d "$1" ] || return 0
  rm -f -- "$1/\${tmp##*/}"
  return 1
}
if [ "$mode" = overwrite ]; then
  mv -f -- "$tmp" "$target"
  placed "$target" || exit ${IS_FOLDER}
  printf '%s' "$target"
  exit 0
fi
path=$target n=0
until ln -- "$tmp" "$path" 2>/dev/null && placed "$path"; do
  if [ ! -e "$path" ]; then
    echo "cannot create $path" >&2
    exit 1
  fi
  [ "$mode" = number ] || exit ${EXISTS}
  n=$((n + 1))
  [ "$n" -le ${MAX_NUMBER} ] || exit ${NO_FREE_NUMBER}
  path="$dir/$stem${NUMBER_SEPARATOR}$n$ext"
done
printf '%s' "$path"`

// Lists the folders in $1, NUL-separated after its absolute path, so any name survives.
const LIST_FOLDERS_SCRIPT = `cd -- "$1" || exit 1
pwd
for d in */ .[!.]*/ ..?*/; do
  [ -d "$d" ] && printf '%s\\0' "\${d%/}"
done
exit 0`

function failure(result: ExecResult, what: string): Error {
  const detail = result.timedOut ? 'timed out' : result.stderr.trim() || `exit code ${result.exitCode}`
  return new Error(`${what}: ${detail}`)
}

/** `name` split before its extension: `photo.png` → `photo` and `.png`; a dotfile has none. */
export function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

/** The file at `path` on the machine `ctx` reaches, as bytes. Refused past `maxBytes`. */
export async function readTerminalFile(
  ctx: TerminalContext,
  path: string,
  opts: { maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  const result = await getBackend(ctx).run(ctx, ['cat', '--', path], {
    binaryStdout: true,
    // One byte past the bound tells a file of exactly the bound from a larger one.
    maxOutputBytes: maxBytes + 1,
    timeoutMs: FILE_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    throw failure(result, `Could not read ${path}`)
  }
  const bytes = result.stdoutBytes ?? Buffer.alloc(0)
  if (bytes.length > maxBytes) {
    throw new Error(`${path} is larger than ${maxBytes} bytes`)
  }
  return bytes
}

/**
 * Writes `data` to `path` on the machine `ctx` reaches, creating its folder, and answers the path
 * it was written to: `path` itself, or with `ifExists: 'number'` the first free `<stem>-<n><ext>`
 * beside it. `ifExists` defaults to `overwrite`. A folder at a name counts as taken, and
 * `overwrite` refuses it rather than replace a folder with a file.
 */
export async function writeTerminalFile(
  ctx: TerminalContext,
  path: string,
  data: Buffer,
  opts: { ifExists?: IfExists } = {},
): Promise<{ path: string }> {
  const ifExists = opts.ifExists ?? 'overwrite'
  const slash = path.lastIndexOf('/')
  const { stem, ext } = splitExtension(path.slice(slash + 1))
  const result = await getBackend(ctx).run(ctx, ['sh', '-c', WRITE_SCRIPT, 'sh', path, ifExists, stem, ext], {
    stdin: data,
    timeoutMs: FILE_TIMEOUT_MS,
  })
  if (result.exitCode === EXISTS) {
    throw new Error(`${path} already exists`)
  }
  if (result.exitCode === IS_FOLDER) {
    throw new Error(`${path} is a folder`)
  }
  if (result.exitCode === NO_FREE_NUMBER) {
    throw new Error(`${path} and every numbered name up to ${stem}${NUMBER_SEPARATOR}${MAX_NUMBER}${ext} exist`)
  }
  if (result.exitCode !== 0) {
    throw failure(result, `Could not write ${path}`)
  }
  return { path: result.stdout }
}

/** The folders directly inside `path` on the machine `ctx` reaches, by name, with `path` made absolute. */
export async function listTerminalFolders(
  ctx: TerminalContext,
  path: string,
): Promise<{ path: string; folders: string[] }> {
  const result = await getBackend(ctx).run(ctx, ['sh', '-c', LIST_FOLDERS_SCRIPT, 'sh', path || '.'])
  if (result.exitCode !== 0) {
    throw failure(result, `Could not list ${path}`)
  }
  const newline = result.stdout.indexOf('\n')
  const folders = result.stdout
    .slice(newline + 1)
    .split('\0')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
  return { path: result.stdout.slice(0, newline), folders }
}
