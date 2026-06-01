# How to add documentation

This guide is for agents (and humans) working inside an OpenCroft repository
who want to add or edit documentation pages that appear in the in-app docs
viewer at `/docs`.

## Where docs live

All documentation is stored under `app/docs/` in the OpenCroft repo. Three
trees:

| Folder | Audience |
| --- | --- |
| `app/docs/user/` | People *using* OpenCroft — deployment guides, how-tos, tutorials |
| `app/docs/nodes/` | One reference page per built-in node type |
| `app/docs/*.md` | Technical docs for people modifying OpenCroft itself |

Every file must be **Markdown** (`.md`).

## MCP tools for docs

If you're an agent connected via MCP, four tools cover the full lifecycle:

| Tool | What it does |
| --- | --- |
| `doc_search(pattern)` | Regex search across all `.md` files. Use it before writing to avoid duplicates. |
| `doc_read(path)` | Read one doc by its relative path (e.g. `"user/README.md"`). |
| `doc_write(path, content)` | Create or overwrite a doc. Creates parent directories automatically. |
| `doc_edit(path, oldString, newString)` | Replace an exact string in an existing doc. Safer than rewriting the whole file. |

**Paths are relative to the docs root** (`app/docs/`). Always end with `.md`.

## Step by step

1. **Search first.** Run `doc_search` with relevant keywords to check if a
   similar page already exists. If it does, edit it instead of creating a
   new one.

2. **Choose the right folder.** User-facing guides go in `user/guides/` or
   `user/`. Node references go in `nodes/`. Internal architecture notes go
   in the docs root.

3. **Write the document.** Use `doc_write` with the relative path and full
   Markdown content. Example:

   ```
   doc_write("user/guides/my-topic.md", "# My Topic\n\nContent here.")
   ```

4. **Verify.** Use `doc_read` with the same path to confirm it was saved
   correctly.

5. **Link it.** If the doc should be discoverable, add a link to the
   relevant `README.md` index (e.g. `user/README.md` for user guides) using
   `doc_edit`.

## Tips

- Keep guides task-oriented: "How to do X", not "Everything about X".
- One topic per file. Split long pages into separate guides.
- Use relative links between docs: `[link text](other-page.md)`.
- `doc_edit` fails if `oldString` is not unique (unless `replaceAll` is
  set). Copy the exact text from `doc_read` output.
