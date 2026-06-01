# Event

Fires a connected handler on a schedule, on a webhook, or manually.

## Inputs

None.

## Outputs

- **Handler** (`exec-out` · orange): `execution-context`. Connect to a
  script.

## Fields

- **Mode**: `cron`, `webhook`, or `manual`.
- **Cron expression**: standard 5-field cron (e.g. `*/5 * * * *`).
  Mode `cron` only.
- **Webhook URL**: generated for mode `webhook`. Read-only.

## Actions

- **Run**: fires the connected handler immediately, regardless of
  mode. Useful for testing.

## Examples

```
Event (cron */5 * * * *) ── Bash Script ── Server     # every 5 minutes
Event (webhook) ── Python Script                       # on POST
Event (manual) ── Node.js Script                       # button only
```

## Notes

- Cron is parsed by the in-process scheduler
  (`server/scheduler/event-scheduler.ts`). It's only as reliable as the
  Next.js process: if you restart the app, jobs resume from the next
  cron tick.
- Webhook URLs follow the same pattern as API Route.
- The handler receives whatever params you passed to **Run** (none for
  cron triggers).
