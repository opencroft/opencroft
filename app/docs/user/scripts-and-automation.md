# Scripts and automation

Run shell, Python or Node scripts on any target. Trigger them from the
canvas, from a webhook, or on a cron schedule.

## Run a script manually

Drop a **Bash Script**, **Python Script** or **Node.js Script** node.
Type into the body. Click **Run**.

By default it runs locally. Connect a target into the **Target** handle
to run somewhere else:

```
Server ── Bash Script
```

Same for Python and Node: they shell out to `python` or `node` on the
target.

## Trigger from a webhook

Drop an **API Route** node. In the inspector:

- **Path**: the path under `/api/route/` (e.g. `webhook/github`).
- **Method**: `POST`, `GET`, etc.

Connect the API Route's **Handler** output to a script's **Handler**
input.

```
API Route ── Python Script
```

When `/api/route/webhook/github` gets hit, the script runs. It receives
the request body and headers in its execution context.

## Trigger on a schedule

Drop an **Event** node. In the inspector pick a mode:

- **Cron**: standard 5-field cron expression (e.g. `*/5 * * * *`).
- **Webhook**: same as API Route, but with built-in URL.
- **Manual**: only fires when you click **Run**.

Connect the Event's **Handler** output to a script.

```
Event (cron */5) ── Bash Script ── Server
```

## Stack the wires

A script can have *both* a Target and a Handler input. The Handler input
says "fire me when this event happens." The Target input says "run me
on this host."

```
Event ── Python Script ── Server
```

Cron triggers the Python script; the script runs on the remote Server.

## Reading inputs from the script

Inside the script body you have:

- **Bash:** `$OPENCROFT_PARAM_*` env vars contain anything passed in
  `params`.
- **Python:** `os.environ['OPENCROFT_PARAM_*']`. Or read JSON from
  stdin if the trigger sent a body.
- **Node:** `process.env.OPENCROFT_PARAM_*`, or `process.stdin`.

Webhook bodies are streamed into stdin verbatim. Cron triggers pass an
empty body.

## Mixing in secrets

Need a token in your script? Don't paste it. Drop a Secrets Store, name
the secret `GITHUB_TOKEN`, then in the script body use `$GITHUB_TOKEN`.
The secret is decrypted into the script's env at run time.

For more on secrets, see [secrets-and-keys.md](secrets-and-keys.md).

## Errors

A failed script puts a red banner on the node. The inspector terminal
tab shows the actual stdout/stderr. The error clears on the next
successful run.
