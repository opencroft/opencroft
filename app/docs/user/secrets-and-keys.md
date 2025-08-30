# Secrets and SSH keys

Two storage nodes for things that shouldn't be plaintext in your graph:

- **Secrets Store**: encrypted key/value pairs (API tokens, passwords,
  env vars).
- **Key Store**: SSH private keys.

Both are nodes you drop on the canvas. Connect them where they're needed.

## Secrets Store

Drop a **Secrets Store** node. The inspector shows a key/value editor.

- **Add** a new entry: give it a name and a value.
- **Edit** in place. Editing auto-saves.
- **Delete**: gone immediately, no undo.

Values are encrypted with AES-256-GCM. The encryption key is derived from
your `SECRETS_KEY` env var (set it in [getting-started](getting-started.md)).

> **Pro tip.** Set `SECRETS_KEY` *before* you store anything. If you
> change it later, run the migration script (see below).

## Use a secret

In any node that supports secrets: Application, scripts, Server: name
the secret in that node's field. At run time the value is decrypted and
injected as an env var.

For example, in an Application's **Secrets** field:

```
DATABASE_URL
GITHUB_TOKEN
```

Both names get looked up across every Secrets Store node in the graph.
The compose project sees them as `${DATABASE_URL}` etc.

In a script, reference `$DATABASE_URL` directly. The script's env
already has it.

## Key Store

Drop a **Key Store** node. The inspector lists every key in the store.

- **Generate**: pick a type (`ed25519`, `rsa`, etc.), a name; OpenCroft
  runs `ssh-keygen` and stashes the keypair.
- **Import**: paste an existing private key.
- **Delete**: drops both private and public files.
- **Copy public key**: copies the `.pub` content for adding to
  `~/.ssh/authorized_keys` on a remote host.

Keys live in `.cache/extensions/builtin/core/key-store/<storeId>/` on
disk. They never enter the graph JSON.

## WSL key sync

On Windows, click **Copy to WSL** on a key. The key is duplicated into
`~/.ssh/keys/` inside your default WSL distro with `chmod 600`. Useful
when an SSH command runs through WSL but the key was generated on
Windows.

## Use a key

Connect the Key Store to a **Server** node. The Server's key dropdown
shows every key in the store. Pick one: that's the auth.

The Server uses the key over `ssh2`'s API. The private file never
leaves OpenCroft's process.

## Rotating the encryption key

If you change `SECRETS_KEY`, every existing secret becomes garbage. To
rotate without losing data, edit `server/crypto.ts` to use a new salt
*before* changing the env var, and run:

```bash
npx tsx scripts/migrate-secrets-salt.ts
```

The script:

- Backs up `data/opencroft.db` to `*.pre-salt-migration.bak`.
- Decrypts every secret with the old salt.
- Re-encrypts with a fresh random salt.
- Updates `server/crypto.ts` to point at the new salt.

After it runs, your `SECRETS_KEY` env var still works: only the salt
changed. Rotating the *passphrase* needs a similar one-off script
(easy to copy from the salt one).

## Don't do this

- Don't paste tokens into the **Env** field: that's in the graph JSON.
  Use **Secrets** instead.
- Don't commit `data/opencroft.db` to git. Even encrypted, it's the only
  copy of your secrets.
