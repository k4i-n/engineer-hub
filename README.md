# engineer-hub

A local work record for one engineer's tickets, kept in one SQLite file and read and written by coding agents through a compact CLI, `hub`.

Agents that keep ticket state in markdown re-read the whole file for every edit, and free-form state grows until a cold start costs thousands of tokens per ticket. `hub` keeps state, timeline, notes, drafts, day plans and the PRs, threads, review requests and alerts of each ticket in one database, caps state fields at one line, and answers "status" and "what is next" in a few short lines.

![Dashboard](docs/images/dashboard.png)

## Install

Needs Node.js 24 or newer (`node:sqlite` with FTS5 and native TypeScript type stripping). No runtime dependencies.

```sh
git clone https://github.com/nhkhai-vn/engineer-hub
cd engineer-hub
ln -s "$PWD/src/cli.ts" ~/.local/bin/hub   # any folder on PATH
hub service install                         # macOS; elsewhere run hub serve under a supervisor
hub board
```

`hub serve` is the only process that opens the database (`~/.hub/hub.db`, or `HUB_DB` / `--db <path>`). The CLI, the dashboard and every agent go through its API at `http://127.0.0.1:7420`.

For Claude Code, install the plugin for the hub MCP tools and the sync and plan skills:

```
/plugin install engineer-hub --marketplace nhkhai-vn/engineer-hub
```

## Example

```sh
hub ticket-new ENG-42 "Sync login sessions across devices" --dir inprogress
hub set ENG-42 next "write the migration for the sessions table"
hub set ENG-42 gate "waiting on design review"
hub log ENG-42 "read the session middleware; sessions are keyed by device id"
hub link ENG-42 https://github.com/acme/web/pull/101
hub board
```

```
== inprogress
  [-] ENG-42 | - | GATE: waiting on design review | next: write the migration for the sessions table
```

Each ticket has its own page with state, steps, timeline, items, waits, drafts and notes:

![Ticket page](docs/images/ticket.png)

## Sources and your setup

Hub's core doesn't depend on any one tool. Tickets, steps, drafts, waits, notes and the day plan live in your local database, and sources only feed **items** into it. A different setup changes which sources you have, not how you work. There are three ways in ([Sources](docs/sources.md)):

1. **Built-in source:** GitHub (review requests and your PRs), Linear and Slack. These carry hub-specific logic, such as closing a review request once it's gone and writing tracker state onto tickets.
2. **Script source:** your script prints item lines on a timer. It can be on/off, have an interval and get its own dashboard card, all in Settings. Hub only stores what the script prints.
3. **Agent path:** Claude reads through a connector and writes items with `item_put`, only while a session runs.

One gap applies to every non-Linear tracker: **tracker sync is Linear-only.** Only the Linear built-in writes the tracker's state, priority and assignee onto the matching hub ticket; that's what the board and the `[TRACKER: ...]` warning read. A script source can only print items, so with another tracker the ticket's own fields are the only state hub has.

**Issue trackers**

| Setup | How it fits | Ticket id | Gap |
|---|---|---|---|
| GitHub Issues | The built-in GitHub source fetches PRs only, not issues. Add a script source using `gh search issues assignee:@me` (no key needed). | `#123` doesn't fit the default `[A-Z]+-\d+`. Use ids like `GH-123` or `web-123`, and set `ticketIdPattern` to match. | PRs attach to tickets by branch or body only if they use the same id form. No tracker sync. |
| Jira | Script source on the Jira REST search (`assignee = currentUser() AND updated > -1d`). Comments and mentions are a second query. | `ABC-123` fits the default pattern as-is. | No tracker sync, so Jira status doesn't show on the board. |
| Notion database | Script source querying the database (filter: assignee is me, edited since `HUB_SINCE`), or the agent path through the Notion connector. | Needs Notion's Unique ID property (for example `TASK-42`); without it there's no id to match PRs and threads. | No tracker sync; comments are a separate API call. |

**Monitoring stack**

All of these become script sources that print `kind: "alert"` and land in Fix now, or in their own card.

| Tool | Feed | Note |
|---|---|---|
| Grafana alerting | Firing alerts API with a read-only token | Has resolved state. The script must print resolved alerts with `needs_me: false` so they leave the card. |
| Better Stack | Uptime incidents API (open incidents) | Same pattern as the bundled incident.io example. |
| PagerDuty / incident.io | Bundled examples | Untested against live accounts. |
| Slack alert channels | Built in (`slackAlertChannels`) | Easiest if alerts already post to Slack. No resolved state; your ✅ clears one. |

**What stays the same in every setup**

- The daily plan, steps, drafts and waits work the same, whatever the tracker.
- A wait closes on reply only through the Slack built-in. With Teams or Discord you'd close waits by hand or write a script for it.
- If a source has no API or token, the agent path through a connector still works, just not in the background.

What makes a setup work well is a **ticket id that appears in branch names, PR bodies and threads**. With that, items attach themselves. Without it, as with GitHub `#123` or a Notion database with no unique ID, you attach by hand.

## Docs

- [CLI](docs/cli.md): every command, field limits, config keys, importing a markdown ticket folder
- [Sources](docs/sources.md): GitHub, Linear and Slack fetched by hub itself, script sources, items from agent connectors
- [Dashboard](docs/dashboard.md): the page, the macOS service, Sync and auto sync, pings to a webhook while you are away
- [Agents](docs/agents.md): the Claude Code plugin and hooks, instructions for agents, the MCP server and the JSON API

## Development

```sh
npm ci
npm run type-check && npm run lint && npm test
```

## License

Apache-2.0
