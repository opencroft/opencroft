# Recovering a lost administrator password

This instance has no email delivery, so there is no "forgot password" link —
Better Auth's own reset flow needs one, and this one does not have one to
send with. If an administrator's password is lost, this is the recovery
path: run a script from the host that resets it directly against the
database.

This is deliberately a break-glass procedure, not a screen. It requires
access to the host the app runs on, which is the same level of access
already needed to read `BETTER_AUTH_SECRET` or the database itself — this
does not open a door that host access did not already open.

## Resetting a password

From the host, in the app's own running environment (same `DATABASE_URL` or
`PGLITE_PATH` it uses — the whole point is to write to the instance's actual
database, not a different one):

```
npx tsx packages/auth/scripts/recover-admin-password.ts <email> <new-password>
```

This hashes the new password with the app's own password hasher (so the
result is one the app can verify at sign-in — it does not reimplement
hashing) and writes it directly to that account's credential row. It prints
the account's role, so you can confirm you reset the one you meant to.

If the email does not resolve to an account, or that account has no
email/password credential (only a social sign-in, for example), the script
says so and does nothing.

## Recovering when there is no administrator at all

Resetting a password only helps if the account is still an administrator.
If it was demoted, disabled, or if you need a different account to be the
administrator instead, promote it directly:

```sql
UPDATE "user" SET role = 'admin' WHERE email = 'someone@example.com';
```

Run against the same database the app is using (see "Resetting a password"
above for how to reach it). `deleteUserAsAdmin` and `updateUserAsAdmin` in
`packages/auth/src/server.ts` refuse to leave the instance with zero
administrators through the app itself — this is the equivalent operation
for when the app cannot be reached through a session at all, which is
exactly the state this procedure exists for.

## Why this and not email

Email-based reset is the seam for when email delivery exists — see
`requireEmailVerification: false` and `changeEmail`'s
`updateEmailWithoutVerification` in `packages/auth/src/server.ts`, both of
which name the same gap. Until then, this is the supported path, not a
workaround: it is written down and has been run end to end against a real
database (create an admin, lose the password by not using it, run the
script, confirm the old password fails and the new one works) rather than
improvised the day it is needed.

## Why this cannot be self-service from the app

The account whose password is lost cannot be signed in to ask the app to
fix it — that is the whole problem. `admin/create-user` and every other
admin action require an admin session to reach; the setup screen refuses to
run a second time once any account exists. None of the app's own doors open
from outside a session, which is why this one goes through the host
instead.
