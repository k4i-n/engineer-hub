---
name: hub-source
description: Add a new source to engineer-hub for a service hub has no built-in for (PagerDuty, incident.io, Cloudflare, Sentry, an internal tool) by writing a small script that hub runs on a timer and that prints item JSON lines. Use when asked to add, connect or track a service, alert feed or tool in hub.
---

# hub-source

Hub runs a script source on a timer, with no shell, `HUB_SINCE` set to the start of its last good run, and a 2 minute timeout. The script prints one item JSON object per line on stdout and exits 0. A non-zero exit or a bad line is the source error and nothing is written. Hub never sees the script's key.

## 1. What needs the engineer

Read the service's API docs and pick only what feeds "needs you": incidents or alerts assigned to or paging the engineer, mentions, review or approval requests. Read only: GET calls, or a read-only GraphQL query.

## 2. Write the script

Copy the closest example from `${CLAUDE_PLUGIN_ROOT}/examples/sources/` (`pagerduty.mjs`, `incident-io.mjs`, `cloudflare.mjs`) to `~/.hub/sources/<name>.mjs` and adapt the host, the auth header and the query. Keep the example's `get()`: it calls through `sealcall call <name>` when `sealcall routes` lists a route named after the source, else reads the Keychain item `engineer-hub/<name>`, else an env variable. Never put a key in the script, its arguments or the chat.

Each line:

```json
{"kind":"alert","ref":"<service>:<id>","url":"<link a human opens>","title":"<one line>","state":"<the service's state>","needs_me":true}
```

`kind` is one of pr, issue, review_request, thread, message, mail, alert, doc, run, other. `ref` is unique and stable per thing; the same ref again updates the row. `source` defaults to the source name. Add `ticket` only when the id is known; a ticket id in the title attaches by itself.

## 3. The key

Give the engineer the one command that stores the key, and let them run it (they paste the key at a prompt, never into the chat):

- sealcall installed (`command -v sealcall`): `sealcall add <name> --host <api host> --header '<Name>: <template with {key}>' --allow 'GET <path glob>'`. The key stays out of every process but sealcall.
- otherwise: `security add-generic-password -s engineer-hub -a <name> -w` (macOS), or an env variable named in the script.

## 4. Try it, then add it

```sh
HUB_SINCE= node ~/.hub/sources/<name>.mjs | head -3     # lines, or the error on stderr
hub source add <name> --every 5m -- node ~/.hub/sources/<name>.mjs [args]
hub fetch <name>
```

`hub source add` works from the terminal only; the API and the dashboard cannot add or change a command hub runs. `hub source set <name> --off` pauses it, `hub source remove <name>` stops it. Report the first lines of `hub items --source <name>` and nothing else.
