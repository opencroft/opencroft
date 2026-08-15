// The script this module builds is shipped into the agent-container verbatim
// (as the argument to `node -e`) and does the actual transcript reduction
// THERE, not on the host. Two reasons, both hard constraints on this rollup:
//
// - Never quote transcript content: the script reads only `.type`, `.timestamp`
//   and `message.model`/`message.usage` off each line — never `message.content`
//   — so conversation text never leaves the container, not even transiently.
// - Keep the wire payload small: a day's transcripts across every agent can be
//   ~100k messages; shipping raw or per-message data every tick does not scale.
//   Reducing in-container means only the aggregated (day, agent, model) rows
//   — at most a few dozen — cross the exec boundary.
//
// rollup-script.test.ts runs this exact script (not a reimplementation of it)
// against fixture transcript files, so there is one implementation, not a
// host copy that can drift from what actually runs.

/** Cache-creation tokens on a single request above this line count it as a cold re-prime. */
export const COLD_PRIME_THRESHOLD_TOKENS = 100_000

export const DEFAULT_PROJECTS_DIR = '/home/node/.claude/projects'

// Single-quote for safe embedding in `sh -c` (the docker-exec backend's shell).
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The Node script (plain CommonJS, no dependencies — it runs with whatever
 * `node` is on the agent-container's PATH) that walks `projectsDir`,
 * reduces every `*.jsonl` transcript dated `sinceDay` or later into
 * `RollupRow[]`, and writes that array as JSON to stdout.
 */
export function buildRollupScript(sinceDay: string, projectsDir: string = DEFAULT_PROJECTS_DIR): string {
  return `
(async () => {
  const fs = require('fs')
  const path = require('path')
  const readline = require('readline')

  const ROOT = ${JSON.stringify(projectsDir)}
  const SINCE_DAY = ${JSON.stringify(sinceDay)}
  const COLD_PRIME_THRESHOLD = ${COLD_PRIME_THRESHOLD_TOKENS}
  // A file's mtime is bumped on every append, so a file last written before
  // this cutoff cannot hold a message timestamped SINCE_DAY or later -- skip
  // reading it entirely instead of streaming the whole transcript archive on
  // every tick. One day of slack under SINCE_DAY guards clock skew and a file
  // whose last write landed right at the boundary.
  const SINCE_CUTOFF_MS = Date.parse(SINCE_DAY) - 24 * 60 * 60 * 1000

  function walk(dir) {
    let out = []
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      return out
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        out = out.concat(walk(full))
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let stat
        try {
          stat = fs.statSync(full)
        } catch (err) {
          continue
        }
        if (stat.mtimeMs < SINCE_CUTOFF_MS) {
          continue
        }
        out.push(full)
      }
    }
    return out
  }

  // The transcript's own project directory name (the first path segment under
  // ROOT), not each message's "cwd" field: a subagent or worktree dispatch can
  // run with a different cwd than its owning agent, but it is always filed
  // under that agent's own project directory.
  function agentFromPath(filePath) {
    const rel = path.relative(ROOT, filePath)
    const top = rel.split(path.sep)[0] || ""
    return top.indexOf("-agents-") === 0 ? top.slice("-agents-".length) : (top || "unknown")
  }

  function rowKey(day, agent, model) {
    return day + "\\u0000" + agent + "\\u0000" + model
  }

  async function processFile(filePath, acc) {
    const agent = agentFromPath(filePath)
    const stream = fs.createReadStream(filePath, { encoding: "utf8" })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) {
        continue
      }
      let entry
      try {
        entry = JSON.parse(line)
      } catch (err) {
        continue
      }
      if (entry.type !== "assistant") {
        continue
      }
      const message = entry.message
      // Absent usage is unknown, never zero -- skip rather than count it.
      if (!message || !message.usage) {
        continue
      }
      const timestamp = entry.timestamp
      if (typeof timestamp !== "string" || timestamp.length < 10) {
        continue
      }
      const day = timestamp.slice(0, 10)
      if (day < SINCE_DAY) {
        continue
      }
      const model = typeof message.model === "string" ? message.model : "unknown"
      const usage = message.usage
      const key = rowKey(day, agent, model)
      let row = acc.get(key)
      if (!row) {
        row = {
          day: day,
          agent: agent,
          model: model,
          requests: 0,
          rawInputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          coldPrimeRequests: 0,
          coldPrimeTokens: 0,
        }
        acc.set(key, row)
      }
      row.requests += 1
      row.rawInputTokens += usage.input_tokens || 0
      row.outputTokens += usage.output_tokens || 0
      const cacheWrite = usage.cache_creation_input_tokens || 0
      row.cacheWriteTokens += cacheWrite
      row.cacheReadTokens += usage.cache_read_input_tokens || 0
      if (cacheWrite > COLD_PRIME_THRESHOLD) {
        row.coldPrimeRequests += 1
        row.coldPrimeTokens += cacheWrite
      }
    }
  }

  const files = walk(ROOT)
  const acc = new Map()
  for (const file of files) {
    await processFile(file, acc)
  }
  process.stdout.write(JSON.stringify(Array.from(acc.values())))
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err))
  process.exitCode = 1
})
`.trim()
}

/** The full `docker exec`-ready shell command: `node -e <script>`. */
export function buildRollupCommand(sinceDay: string, projectsDir: string = DEFAULT_PROJECTS_DIR): string {
  return `node -e ${shellQuote(buildRollupScript(sinceDay, projectsDir))}`
}
