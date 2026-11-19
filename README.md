# engineer-hub

A local work record for one engineer's tickets, kept in one SQLite file and read and written by coding agents through a compact CLI, `hub`.

Agents that keep ticket state in markdown pay twice: every state edit needs a read of the whole file first, and free-form state fields grow until a "cheap" cold start costs thousands of tokens per ticket. `hub` puts state, timeline, notes, drafts, day plans, the PRs, threads, review requests and alerts attached to each ticket, and its own config in one database, enforces one-line limits on state fields at write time, and answers "status" and "what is next" with a few short lines.

## Install

Needs Node.js 24 or newer (`node:sqlite` with FTS5 and native TypeScript type stripping). No runtime dependencies.

```sh
git clone https://github.com/nhkhai-vn/engineer-hub
cd engineer-hub
ln -s "$PWD/src/cli.ts" ~/.local/bin/hub   # any folder on PATH
hub service install                         # macOS; elsewhere run hub serve under a supervisor
hub board
```

`hub serve` is the only process that opens the database (`~/.hub/hub.db`; `HUB_DB` or `--db <path>` points elsewhere, created on first start). Every other command, and every agent, goes through it: the CLI calls its API at `http://127.0.0.1:7420` (`HUB_URL` for another) with the token next to the database, and says so when it is not running. The CLI sends the database path it was pointed at, and a hub serving another database refuses. `hub config syncCommand` is the one write made straight to the file, since the API refuses keys that run commands.

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

## Commands

Every read takes `--json`. Errors are one line on stderr with exit 1; an unknown command prints usage and exits 2.

| Read | Prints |
|---|---|
| `hub ticket <id>` | state, tracker fields, step progress and the next step, the last 3 events, open drafts, open items and waits, note titles (under 25 lines) |
| `hub board [regex]` | open tickets grouped by dir, one line each |
| `hub next` | the next action of each ticket in progress, then to do, by tracker priority |
| `hub gates` | tickets waiting on a human decision |
| `hub changed --since <date\|yesterday\|today>` | events and state changes since a day |
| `hub search <query> [-n 10]` | full-text search over tickets, notes, events and drafts |
| `hub events <id> [-n 20] [--full]`, `hub notes <id>`, `hub note-show <id> <title>` | timeline and notes |
| `hub drafts [id]`, `hub draft-show <id> <label>` | messages for humans to post |
| `hub items [--needs-me] [--source <s>] [--ticket <id>] [--all]` | open items (PRs, threads, review requests, alerts…), the ones that need you first |
| `hub waits [--due]` | questions asked of someone; `--due` lists the ones to ping now |
| `hub sources` | each source's last sync, cursor and error |
| `hub steps <id>` | the ticket's steps, done ones ticked, with their evidence |
| `hub brief` | what a sync needs to judge new messages: sources and cursors, open tickets, unsent drafts, drafts sent with wording pending, waits, tracked items (each section capped at 40 lines) |
| `hub day [date]` | the RESUME block of a day plan (today, else the latest) |
| `hub lint` | open tickets missing status, next or owner, or over a limit; exit 1 if any |
| `hub config [key]` | effective config |

| Write | Does |
|---|---|
| `hub set <id> <field> <value>` | field is status, repo, worktree, branch, prs, gate, decide, next or owner |
| `hub log <id> <text> [--kind log] [--source agent] [--ref <url>]` | adds an event stamped in the configured timezone |
| `hub note <id> <title> (--file <path> \| --stdin) [--kind detail]` | adds or replaces a note |
| `hub draft <id> <label> (--file \| --stdin) [--channel <c>] [--send-at <when>]` | adds or replaces a draft; `--send-at` takes `30m`, `4h`, `tomorrow`, `12:00`, `tomorrow 12:00` or `2026-11-20 12:00` |
| `hub draft-later <id> <label> [--for <when>]` | moves a draft's send time (default tomorrow) |
| `hub posted <id> <label> [--at <when>] [--channel <c>] [--answer <text>] [--ref <url>] [--file \| --stdin]` | marks a draft posted or answered; the text given is the wording actually sent, which may differ from the draft (without it the draft shows "wording pending") |
| `hub link <id> <url> [--kind <k>] [--title <t>]` | attaches the URL to the ticket as an item; source and kind come from the URL |
| `hub match <id> <label> --ref <url> (--file \| --stdin)`, `hub match <id> <label> (yes \| no)` | proposes a sent message as the wording of a draft when the agent is unsure; yes marks the draft posted with it, no drops it |
| `hub step add <id> <title>`, `hub step done <id> <n> [--evidence <url>]` | appends a step, marks one done and logs it |
| `hub item put --stdin` | stores items read from a source, one JSON object per line (below) |
| `hub item close <item>...`, `hub item snooze <item> [--for 1d|tomorrow]`, `hub item attach <item> <id>` | marks items handled, hides one for a while (a change brings it back), attaches one to a ticket; `<item>` is the `#` number or the ref |
| `hub wait <id> <who> <url> [--ping-after 1d]`, `hub wait close <wait \| url>` | records a question asked of someone, closes it when they answer |
| `hub source <name> [--cursor <c>] [--error <text>]` | records a sync of a source |
| `hub day set <date> (--file \| --stdin)` | stores a day plan |
| `hub ticket-new <id> <title> [--dir todo]`, `hub move <id> <dir>` | creates a ticket, moves it between dirs |
| `hub config <key> <json>` | stores a config value, checked against the default's type |

## Limits

State fields are one line. Status, repo, PRs, gate, decide and next are capped at 240 characters and owner at 120. `hub set` refuses longer values and names the place for the detail:

```
next is 300 chars (max 240): put the detail in a note (hub note) or the log (hub log) and keep next to one line
```

Change a limit with `hub config limits '{"next":300}'`.

## Config

Config lives in the database. `hub config` lists every key with its value:

| Key | Default | Used for |
|---|---|---|
| `timezone` | `"Asia/Tokyo"` | event timestamps and "today" |
| `ticketIdPattern` | `"[A-Z]+-\\d+"` | tracker ids such as `ENG-42` |
| `localIdPrefixes` | `["DRAFT-","NEW-"]` | ids of tickets that exist only locally |
| `taskDirs` | `["inprogress","todo","triage","backlog","done"]` | ticket dirs; the first two are what `hub next` lists |
| `openDirs` | `["inprogress","todo","triage","backlog","unfiled"]` | dirs `hub board` shows, in order |
| `limits` | see Limits | write-time field limits |
| `trackerHosts` | `["linear.app"]` | URLs whose links count as the tracker |
| `syncCommand` | `claude -p /engineer-hub:hub-sync …` | what the dashboard's Sync runs |
| `layout` | `{"top":["overview"],"left":[…],"right":[…]}` | where each dashboard card sits |
| `hiddenBlocks` | `[]` | dashboard cards that are hidden |
| `progressStyle` | `"ring"` | step progress as `ring`, `half` or `bar` |
| `chartDays` | `14` | days the overview charts cover: 7, 14 or 30 |
| `doneDays` | `14` | days the Done tab looks back: 7, 14 or 30 |
| `laterHour` | `9` | the hour "later until tomorrow" means |
| `stateFields`, `sections`, `trackerSyncMarkers`, `planDir`, `resumeHeading` | | markdown conventions the importer reads |

## Sources hub fetches itself

`hub serve` fetches its built-in sources on a timer (every minute; Settings → Sources, config `fetch` and `fetchEvery`), with no Claude session and no plan quota. `hub fetch [source]` runs them now.

| Source | Fetches | Credential |
|---|---|---|
| `github` (on by default) | review requests (closed when no longer requested), your PRs updated since the last fetch with review decision and checks: approved, changes requested and checks failing need you | none in hub: it runs your signed-in `gh` |
| `linear` | issues assigned to you updated since the last fetch (a new one with no hub ticket needs you; done and canceled do not), and mentions of you in issues and comments | a personal API key with read access |
| `slack` | messages that mention you (need you), messages you sent (state `sent`, for an agent to match to drafts), and replies in threads you wait on (the wait closes and the reply needs you). Not yet: DMs that do not mention you | a user token (`xoxp-`) |

A source that fails shows its reason in Settings and in the header, with the command that fixes it. Sources with an API key call through sealcall when `sealcall routes` lists a route named after the source, so hub never sees the key; otherwise hub reads its own Keychain item `engineer-hub/<source>` (`HUB_<SOURCE>_KEY` off macOS), which any process running as you can read. For Linear:

```sh
security add-generic-password -s engineer-hub -a linear -w     # hub's own item; paste the key at the prompt
sealcall add linear --host api.linear.app --header 'Authorization: {key}' --allow 'POST /graphql'   # or sealcall
hub config fetch '{"github":true,"linear":true}'
```

For Slack, create an app in your workspace (api.slack.com/apps → From scratch), add the user token scopes `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history` and `users:read`, install it to the workspace (some workspaces need an admin to approve), and store the User OAuth Token from the install page:

```sh
security add-generic-password -s engineer-hub -a slack -w      # paste the xoxp- token
sealcall add slack --host slack.com --header 'Authorization: Bearer {key}' \
  --allow 'GET /api/auth.test' --allow 'GET /api/search.messages' --allow 'GET /api/conversations.replies'   # or sealcall
```

### Script sources

For a service hub has no built-in for, a small script of yours runs on its own timer:

```sh
hub source add pagerduty --every 5m -- node examples/sources/pagerduty.mjs
hub fetch pagerduty
hub source remove pagerduty
```

hub runs the program and its arguments with no shell, a 2 minute timeout and `HUB_SINCE` set to the start of its last good run, and reads one item JSON object per line from stdout (`source` defaults to the script's name). A non-zero exit or a bad line writes nothing and is the source error (with the last stderr line). Script sources are added and removed from the terminal only; the API and the dashboard cannot set a command hub runs. `examples/sources/` has PagerDuty, incident.io and Cloudflare scripts to copy; each calls through sealcall when a route with its name exists, else reads its own Keychain item, so hub never sees their keys (written from the vendors' API docs, not run against live accounts). The `hub-source` skill writes one for a named service.

## Items from connectors

For everything else an agent reads each source (Slack, the tracker, mail, alerts) through the connector it already has, and writes what it found with `hub item put --stdin` (or the `item_put` tool), one object per line:

```json
{"source":"github","kind":"review_request","url":"https://github.com/acme/web/pull/130","title":"ENG-7: cap exports","state":"open","needs_me":true}
{"source":"grafana","kind":"alert","ref":"alert-991","title":"API 5xx above 2%","needs_me":true}
```

| Key | |
|---|---|
| `source` | lowercase name, required |
| `kind` | `pr`, `issue`, `review_request`, `thread`, `message`, `mail`, `alert`, `doc`, `run` or `other`, required |
| `ref` | the item's identity; defaults to `url`, one of the two is required |
| `title`, `url`, `state`, `author` | optional; a missing key keeps the stored value |
| `ticket` | attach to this ticket; without it an id matching `ticketIdPattern` in the title or URL attaches it |
| `needs_me` | `true` when the item waits on you |

The batch is checked whole before anything is written. An unchanged item changes nothing. A new item on a ticket, an attach and a state change become `sync` events on the ticket. A state change or a new `needs_me` reopens a closed item.

## Claude Code plugin

The repository is a Claude Code plugin: the hub MCP server and two skills.

- `.mcp.json` connects to `${HUB_URL:-http://127.0.0.1:7420}/mcp`; its `headersHelper` runs `hub mcp-headers`, which prints the bearer header from the token next to the database (`HUB_DB`), so no token sits in a config file or the environment. `alwaysLoad` makes a headless `claude -p` wait for the hub tools before it starts.
- `hub-sync`: reads what is new since each source's cursor (GitHub through `gh`, Slack, the tracker and mail through the session's connectors), read only, judges it against the hub `brief`, and writes items, posted drafts, closed waits and log lines through the hub tools.
- `hub-plan`: syncs, then writes the plan for today with `day_set`.

```
/plugin install engineer-hub --marketplace nhkhai-vn/engineer-hub
```

Tools show as `mcp__plugin_engineer-hub_hub__<tool>`; allow the whole server with `mcp__plugin_engineer-hub_hub`.

The plugin's hooks tell every Claude Code session what moved, without a tool call: at session start a one-line count (`hub: 3 need you: 2 review requests, 1 alert; 1 ping due.`), and before each prompt the new or changed items that need you, answered waits, pings that came due and your dashboard clicks since that session's last look (nothing when nothing moved, or when hub is not running). Each session keeps its own mark. The same from a shell: `hub moved --as <session id> [--start]`.

## Dashboard

```sh
hub serve                # http://127.0.0.1:7420, --port to change
hub service install      # macOS: run hub serve at login and restart it if it stops
hub service status       # running (pid) or not installed; exit 1 when not running
hub service uninstall
```

The service runs `hub serve` with the `--db` and `--port` given at install and the `PATH` of the shell that installed it (so Sync finds `claude`), and logs to `serve.log` next to the database. On Linux, run `hub serve` under a systemd user unit or another supervisor. The write token lives in `token` next to the database (mode 600, made on first start) and stays the same across restarts; delete the file for a new one.

A live page on this machine only: what needs you (review requests, mentions, alerts, pings that are due, proposed draft matches, gates), every open ticket with step progress, next step, PR and Slack chips, today's plan, drafts with Copy and Sent, and what changed since yesterday; one page per ticket with state, steps, timeline, items, waits, drafts and notes. Any write, from the CLI, an agent or the page, shows within a second.

A full-width top row holds the Overview: how many things need you, split by category (a click jumps to that card), the share of steps done across open tickets as a gauge, open tickets by state as a donut, and steps done per day as a line chart with the change against the previous period (7, 14 or 30 days, switched in the card). Below it are two columns. What needs you is split into cards by what to do: Pinned, Fix now (alerts), Review, Reply (messages and sent-draft checks), My PRs, Triage, Waiting on (pings due), Decide (approve? and decide), each with a count; a click on a card title folds it and the browser remembers. The total sits next to the hub logo, and a ticket with open rows shows "2 need you" (its page lists them). Every card, Tickets, Today, Drafts and Activity can be dragged by the grip at its top right to any place in the top row or either column, or moved or hidden with the grip menu; the order is stored in the `layout` config key, and Settings shows or hides each card and has Reset. Ticket progress is a ring with the percentage by default (Settings: ring, half circle or bar). Every row ends in the same three controls: ✓ handled (done, or answered for a ping), a clock for later (snooze, or "pinged, remind me"; one click means tomorrow 09:00, Settings: 7:00 to 10:00) and ⋯ (pin to top, snooze 1 hour, 4 hours or until tomorrow, open, copy link). Questions (is this your sent draft? approve?) are answered with Yes / No under the title. A draft with a send time waits dimmed in Drafts with its time; once due it is a Send row under Reply with Copy, ✓ Sent and the clock for later. A draft with a send time waits dimmed in Drafts with its time; once due it is a Send row under Reply with Copy, ✓ Sent and the clock for later. Done, snoozed and answered rows stay in place, dimmed, with Undo, while the page is open; after a reload they sit in a folded "Done & snoozed" line at the end of their group until the day ends. Today shows its first 3 list items, draft bodies show one line until clicked, Activity shows the last 5, and the header names only sources that are failing or stale. Tickets has two tabs: Ongoing, and Done for tickets finished in the last 14 days (Settings: 7, 14 or 30). The tab title and icon carry the count, new rows flash, and with notifications on (Settings) a background tab raises a browser notification. Settings (`/settings`, or `,`) choose browser or app for Slack and Linear links, notifications, sound, theme, time zone and the sync command, and show the database path. Sync is the round-arrows icon in the header (it spins while a run is going; hover shows the elapsed time). Auto sync is on by default: `hub serve` starts the same run every 15 minutes after the last one (Settings → Sync: off, or 15 min, 30 min, 1 hour, 2 hours; config `autoSync`, `syncEvery`). Each run is a headless Claude session and uses plan quota. The search box in the header (`/`) finds tickets, items, steps, notes, drafts and log lines as you type; arrows pick, Enter opens, Esc clears. Keys: `j`/`k` move, `Enter` opens, `e` handled, `s` later, `y`/`n` yes or no, `p` pin, `u` undo, `/` search, `,` settings (again to go back).

Sync runs `syncCommand` (default `claude -p /engineer-hub:hub-sync` with the hub MCP tools and `gh` read commands allowed), once at a time, with `HUB_DB` and `HUB_URL` pointing at the serving hub. Each run spends Claude usage. A headless run can use only the tools it is allowed, so add each connector you sync from:

```sh
hub config syncCommand '["claude","-p","/engineer-hub:hub-sync","--allowedTools","mcp__plugin_engineer-hub_hub,Bash(gh search:*),Bash(gh pr view:*),mcp__claude_ai_Slack,mcp__claude_ai_Linear,mcp__claude_ai_Gmail"]'
```

## API

`hub serve` answers a JSON API at `http://127.0.0.1:7420/api/v1/`, the same reads and writes as the CLI with the same checks and limits; the dashboard uses it too. `/api/v1/openapi.json` lists every route. Send the token file next to the database as a bearer token:

```sh
curl -H "Authorization: Bearer $(cat ~/.hub/token)" http://127.0.0.1:7420/api/v1/tickets/ENG-42
curl -H "Authorization: Bearer $(cat ~/.hub/token)" -H "Accept: text/plain" http://127.0.0.1:7420/api/v1/next
curl -X PATCH -H "Authorization: Bearer $(cat ~/.hub/token)" -H "Content-Type: application/json" \
  -d '{"next":"open the PR","gate":"-"}' http://127.0.0.1:7420/api/v1/tickets/ENG-42
```

What you click on the dashboard (done, later, answered, sent, a match answer) is recorded as a `human` event, and `brief` lists those since the previous brief under "from you", so an agent learns them without opening each ticket. Responses are the CLI's `--json` output, or its text with `Accept: text/plain` (the CLI's exit code is in `x-hub-exit`). Writes take a JSON body; an unknown, missing or mistyped field is refused with `400 {"error": ...}`. A ticket `PATCH` applies all its fields or none. Config keys that run commands (`syncCommand`) are set from the terminal only.

## MCP

`hub serve` is also an MCP server (streamable HTTP) at `http://127.0.0.1:7420/mcp`, with the same bearer token. Its tools are the API's routes for agents (`brief`, `board`, `ticket`, `ticket_set`, `log`, `item_put`, `wait_add`, `draft_save`, `posted`, `match`, `step_done`, ...), each read-only or marked when it replaces data. Tools never answer for the human: there is no gate answer, no match answer, no pin, config or Sync. The Claude Code plugin below connects it for you. For any other agent that speaks MCP:

```json
{ "mcpServers": { "hub": { "type": "http", "url": "http://127.0.0.1:7420/mcp", "headers": { "Authorization": "Bearer ${HUB_TOKEN}" } } } }
```

with `HUB_TOKEN=$(cat ~/.hub/token)` in the environment, or a `headersHelper` of `hub mcp-headers` where the client has one.

## Import from a markdown ticket folder

```sh
hub import --root ~/work/agent           # dry run: counts and findings
hub import --root ~/work/agent --apply   # writes; a second --apply reports changes: 0
```

The importer reads, and never writes:

- `tasks/<dir>/**/<id>*.md`: a `Status:` / `Repo:` / `Next:` … state block, `## Log` entries (`- 2026-11-12 14:20: text`), `## Messages` drafts (`### label`), and a tracker block between the sync markers.
- `plan/plan-YYYY-MM-DD.md`: day plans.

Every section lands in the database. Other headings become notes. A state field over its limit is cut and its full text kept in a `State notes` note. After the import, move the markdown folder to a backup: from then on the database is the only source of truth.

## For agents

With the hub MCP tools connected (plugin or `/mcp`), put this in the agent's instructions; the server's MCP instructions say the same in short:

```
Cold start for a ticket: brief, then board or ticket. Read a note only when the next action needs it (note).
During work: log what changed, readings and decisions; ticket_set next (one action) and gate (a decision waiting on the human); link every PR, run, thread or doc touched.
Waiting on someone: wait_add with ping_after; waits with due says whom to ping.
Drafts for humans to post: draft_save; when posted: posted with the wording actually sent and its permalink.
Daily plan: day to resume; day_set after writing it. Longer content: note_save.
State fields are one line each; hub refuses more and says where the text belongs. Never answer a gate or a draft match for the human.
```

Without MCP, the same through the CLI: `hub ticket`, `hub log`, `hub set`, `hub link`, `hub wait`, `hub draft`, `hub posted`, `hub day set`, `hub note`.

## Development

```sh
npm ci
npm run type-check && npm run lint && npm test
```

## License

Apache-2.0
