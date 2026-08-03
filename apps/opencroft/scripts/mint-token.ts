/**
 * Mint a machine token for the HTTP MCP surface.
 *
 *     npm run mint-token -- --app-stopped --agent alice [--label laptop]
 *     npm run mint-token -- --app-stopped --list
 *     npm run mint-token -- --app-stopped --revoke <id>
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STOP THE APP FIRST. This is not a style preference.
 *
 * On a PGlite-backed instance — the default for a deployment — the
 * database is a directory, not a server, and PGlite does NOT lock it. A second
 * process opens it happily, reads a STALE copy, and on close can silently
 * discard everything the app wrote in the meantime. Both processes exit 0 and
 * nothing anywhere reports a problem. This has been measured.
 *
 * So running this against a live instance can destroy data while appearing to
 * succeed. The check below refuses when the app looks like it is running, but
 * it is a courtesy, not a guarantee — treat "app stopped" as the requirement.
 *
 * This does not apply when DATABASE_URL points at a real Postgres server,
 * which does lock properly.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY A SCRIPT AND NOT AN ADMIN PAGE
 *
 * The first token cannot be issued through an authenticated session, because
 * the credential it is bootstrapping is the one guarding the surface, and on
 * production auth is fail-closed until BETTER_AUTH_SECRET is provisioned. An
 * admin UI can come later as a convenience for rotation on a healthy instance.
 * It must never be the only path, or recovery depends on the thing that is
 * down.
 */

import { randomBytes } from 'node:crypto'
import path from 'node:path'

// From '@opencroft/db/connect', NOT '@opencroft/db'. The package index runs
// `export const db = await openDb()` at module load, so importing anything
// from it opens the database as a side effect of the import — before a line of
// this script has run. This process would then hold two PGlite handles on one
// datadir, which is the silent-data-loss case from the header comment.
//
// This is not hypothetical: the first version of this script imported openDb
// from the index, and the guard below tripped on a postmaster.pid that the
// import itself had just created.
import { openDb } from '@opencroft/db/connect'
import { apiToken } from '@opencroft/db/schema'
import { desc, eq, isNull } from 'drizzle-orm'

// Deliberately NOT from caller.ts: that imports `@opencroft/db`, whose index
// opens the database at module load, and this script opens it itself. Two
// PGlite handles on one datadir in one process is the silent-data-loss case in
// the header comment.
import { hashToken } from '@/app/(mcp)/_server/token-hash'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/**
 * Make the operator assert that the app is stopped, because this script CANNOT
 * find out for itself.
 *
 * The obvious check is postmaster.pid in the datadir. It does not work: PGlite
 * writes a hardcoded `-42` there, along with an internal wasm path rather than
 * the real one, and leaves the file behind after a clean shutdown. Measured on
 * a live datadir and on a stopped one — byte for byte the same `-42`. So the
 * file says nothing about whether anything holds the database, and a guard
 * built on it refuses every run after the first, which just teaches everyone
 * to pass --force. A safety check people route around by habit is worse than
 * none, because it also looks like protection in the logs.
 *
 * There is currently no reliable way to detect a live PGlite datadir from its
 * contents. That is itself the strongest argument for the lockfile suggested
 * for PGlite; until that exists, an explicit assertion is the honest
 * option. It is one flag, it is in the usage line, and it is not a warning to
 * be clicked through — it is the operator stating the precondition.
 */
function requireAppStopped(): void {
  if (process.env.DATABASE_URL) {
    // A real Postgres server locks properly; concurrency is its problem, and
    // it solves it.
    return
  }
  if (has('app-stopped')) {
    return
  }
  const dataDir = process.env.PGLITE_PATH ?? path.join(process.cwd(), 'data', 'pglite')
  console.error(
    [
      '',
      'Refusing to run without --app-stopped.',
      '',
      `This instance is PGlite-backed (${dataDir}), and PGlite does not lock its`,
      'datadir. If the app is running, this process gets a second handle on the',
      'same database: it reads a stale copy, and on close can silently discard',
      'everything the app wrote meanwhile. Both processes exit 0 and nothing',
      'reports a problem. This has been measured and confirmed.',
      '',
      "This script cannot detect whether the app is running — PGlite's",
      'postmaster.pid is a hardcoded -42 and survives shutdown, so it carries no',
      'liveness information at all.',
      '',
      'Stop the app, then re-run with --app-stopped.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const { db, close } = await (async () => {
  requireAppStopped()
  return openDb()
})()

try {
  if (has('list')) {
    const rows = await db.select().from(apiToken).where(isNull(apiToken.revokedAt)).orderBy(desc(apiToken.createdAt))
    if (rows.length === 0) {
      console.log('No live tokens.')
    }
    for (const r of rows) {
      const used = r.lastUsedAt ? r.lastUsedAt.toISOString() : 'never'
      console.log(`${r.id}  ${r.agent.padEnd(16)} ${(r.label || '-').padEnd(20)} last used: ${used}`)
    }
  } else if (has('revoke')) {
    const id = arg('revoke')
    if (!id) {
      console.error('Usage: --revoke <id>   (get ids from --list)')
      process.exit(1)
    }
    const [row] = await db
      .update(apiToken)
      .set({ revokedAt: new Date() })
      .where(eq(apiToken.id, id))
      .returning({ id: apiToken.id, agent: apiToken.agent })
    if (!row) {
      console.error(`No token with id ${id}`)
      process.exit(1)
    }
    console.log(`Revoked ${row.id} (${row.agent}). It stops working immediately — no restart needed.`)
  } else {
    const agent = arg('agent')
    if (!agent) {
      console.error('Usage: --agent <name> [--label <text>]')
      process.exit(1)
    }
    // 32 bytes of CSPRNG, base64url. The prefix is a courtesy to whoever finds
    // one of these in a config file and has to work out what it is.
    const token = `oc_${randomBytes(32).toString('base64url')}`
    const [row] = await db
      .insert(apiToken)
      .values({ agent, label: arg('label') ?? '', tokenHash: hashToken(token) })
      .returning({ id: apiToken.id })

    console.log('')
    console.log(`  agent: ${agent}`)
    console.log(`  id:    ${row.id}`)
    console.log(`  token: ${token}`)
    console.log('')
    console.log('  Shown once — only the hash is stored, so this cannot be recovered.')
    console.log('  Send it as:  Authorization: Bearer <token>')
    console.log('')
    console.log("  Issuing this does not revoke the agent's other tokens. Rotate by")
    console.log('  minting, reconfiguring, then --revoke on the old id.')
    console.log('')
  }
} finally {
  // openDb's contract: one-shot scripts must close so an embedded PGlite
  // flushes before the process exits.
  await close()
}
