// Break-glass recovery: reset an account's password directly against the
// database, for when it is lost and there is no other way in. See
// packages/auth/RECOVERY.md for when this applies and how to use it.
//
// Run from the host, inside the running app's own environment (the same
// DATABASE_URL / PGLITE_PATH it uses), so this writes to the actual
// instance's database rather than a different one:
//
//   npx tsx packages/auth/scripts/recover-admin-password.ts <email> <new-password>
//
// Uses the app's own password hasher (via the auth server's `$context`)
// rather than reimplementing it, so the hash this writes is one the app can
// actually verify against at sign-in.

import { account, db, user } from '@opencroft/db'
import { and, eq } from 'drizzle-orm'

import { ensureAuth } from '../src/server'

async function main() {
  const [email, newPassword] = process.argv.slice(2)
  if (!email || !newPassword) {
    console.error('Usage: recover-admin-password.ts <email> <new-password>')
    process.exitCode = 1
    return
  }

  const [target] = await db.select().from(user).where(eq(user.email, email.toLowerCase()))
  if (!target) {
    console.error(`No account with email "${email}".`)
    process.exitCode = 1
    return
  }

  const [credential] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, target.id), eq(account.providerId, 'credential')))
  if (!credential) {
    console.error(
      `The account for "${email}" has no email/password credential to reset (it may be social-sign-in only).`,
    )
    process.exitCode = 1
    return
  }

  const ctx = await ensureAuth().$context
  const passwordHash = await ctx.password.hash(newPassword)
  await db.update(account).set({ password: passwordHash }).where(eq(account.id, credential.id))

  console.log(`Password reset for ${target.email} (role: ${target.role ?? 'user'}).`)
  if (target.role !== 'admin') {
    console.warn(
      'This account is not an administrator. To recover admin access specifically, target the ' +
        "administrator's own email — or see RECOVERY.md for promoting an account to admin directly.",
    )
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    // A one-shot CLI script: exit once the work above is done rather than
    // waiting on whatever the database driver leaves open (a pg Pool with
    // live sockets does not let the process exit on its own).
    process.exit(process.exitCode ?? 0)
  })
