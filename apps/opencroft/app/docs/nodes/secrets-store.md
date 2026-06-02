# Secrets Store

Encrypted key/value pairs. Used by Applications, Server, scripts :
anywhere a secret value is needed without putting it in the graph
JSON.

## Inputs

None.

## Outputs

None: values are looked up by name across every Secrets Store node.

## Fields

A key/value editor:

- **Add**: give a name and a value. Auto-saves.
- **Edit** in place.
- **Delete**: gone immediately, no undo.

## Actions

None.

## Examples

Reference a secret in an Application's **Secrets** field by name:

```
DATABASE_URL
GITHUB_TOKEN
```

The compose project sees them as `${DATABASE_URL}` etc.: values are
decrypted at start time.

In a script body, `$GITHUB_TOKEN` works directly. The runner injects
named secrets as env vars before launching the script.

## Notes

- Values are AES-256-GCM encrypted. The key is derived from the
  `SECRETS_KEY` env var.
- Lookups span every Secrets Store in every space: names should be
  globally unique to avoid surprises.
- See [secrets-and-keys](../user/secrets-and-keys.md) for rotation.
