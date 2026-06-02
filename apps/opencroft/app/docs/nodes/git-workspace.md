# Git Workspace

A staging area for git clones on a target host. Lists repositories under
a workspace root and offers `git clone` with optional auth.

## Inputs

- **Terminal** (`ctx-in` · violet): `terminal-context`. Where `git`
  runs. Defaults to local.

## Outputs

None.

## Fields

- **Workspace path**: directory on the target where clones land.
- **Repositories**: auto-discovered list once a workspace is set.

## Actions

The inspector exposes:

- **List repos**: calls `git.listRepos`.
- **Clone…**: opens a dialog for URL, optional secret to use as
  credentials.

## Examples

```
Server ── Git Workspace
```

Use it as scratch space before deploying: clone the repo, point an
**Application** with **Build context** at it, click **Start**.

## Notes

- Auth is read from the optional secrets you pick in the clone dialog.
  No keys live on the workspace node itself.
- `git` must be installed on the target. The Stats fail gracefully if
  it isn't.
