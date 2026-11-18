# engineer-hub

A local work record for one engineer's tickets, kept in one SQLite file and read and written by coding agents through a compact CLI, `hub`.

Agents that keep ticket state in markdown pay twice: every state edit needs a read of the whole file first, and free-form state fields grow until a "cheap" cold start costs thousands of tokens per ticket. `hub` puts state, timeline, notes, drafts, day plans, the PRs, threads, review requests and alerts attached to each ticket, and its own config in one database, enforces one-line limits on state fields at write time, and answers "status" and "what is next" with a few short lines.

## Install

Needs Node.js 24 or newer (`node:sqlite` with FTS5 and native TypeScript type stripping). No runtime dependencies.

```sh
git clone https://github.com/nhkhai-vn/engineer-hub
cd engineer-hub
ln -s "$PWD/src/cli.ts" ~/.local/bin/hub   # any folder on PATH
hub board
```

The database is `~/.hub/hub.db`; `HUB_DB` or `--db <path>` points elsewhere. It is created on first use.

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
| `hub ticket <id>` | state, tracker fields, the last 3 events, open drafts, open items and waits, note titles (under 25 lines) |
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
| `hub brief` | what a sync needs to judge new messages: sources and cursors, open tickets, unsent drafts, drafts sent with wording pending, waits, tracked items (each section capped at 40 lines) |
| `hub day [date]` | the RESUME block of a day plan (today, else the latest) |
| `hub lint` | open tickets missing status, next or owner, or over a limit; exit 1 if any |
| `hub config [key]` | effective config |

| Write | Does |
|---|---|
| `hub set <id> <field> <value>` | field is status, repo, worktree, branch, prs, gate, decide, next or owner |
| `hub log <id> <text> [--kind log] [--source agent] [--ref <url>]` | adds an event stamped in the configured timezone |
| `hub note <id> <title> (--file <path> \| --stdin) [--kind detail]` | adds or replaces a note |
| `hub draft <id> <label> (--file \| --stdin) [--channel <c>]` | adds or replaces a draft |
| `hub posted <id> <label> [--at <when>] [--channel <c>] [--answer <text>] [--ref <url>] [--file \| --stdin]` | marks a draft posted or answered; the text given is the wording actually sent, which may differ from the draft (without it the draft shows "wording pending") |
| `hub link <id> <url> [--kind <k>] [--title <t>]` | attaches the URL to the ticket as an item; source and kind come from the URL |
| `hub match <id> <label> --ref <url> (--file \| --stdin)`, `hub match <id> <label> (yes \| no)` | proposes a sent message as the wording of a draft when the agent is unsure; yes marks the draft posted with it, no drops it |
| `hub item put --stdin` | stores items read from a source, one JSON object per line (below) |
| `hub item close <item>...`, `hub item attach <item> <id>` | marks items handled, attaches one to a ticket; `<item>` is the `#` number or the ref |
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
| `stateFields`, `sections`, `trackerSyncMarkers`, `planDir`, `resumeHeading` | | markdown conventions the importer reads |

## Items from connectors

hub has no source code, API client or token. An agent reads each source (GitHub, Slack, the tracker, mail, alerts) through the connector it already has, and writes what it found with `hub item put --stdin`, one object per line:

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

Put this in the agent's instructions:

```
Cold start for a ticket: `hub board <id>` then `hub ticket <id>`. Read a note only when the next action needs it: `hub note-show <id> "<title>"`.
During work, in the same shell call as the work: `hub log <id> "<what changed, readings, decisions>"`, `hub set <id> next "<one action>"`, `hub set <id> gate "<decision waiting on the human, or ->"`, `hub link <id> <url>` for every PR, run, thread or doc touched.
Waiting on someone: `hub wait <id> "<who>" <thread url> --ping-after 1d`; `hub waits --due` says whom to ping.
Sync: read only what is new since `hub sources` shows, write it with `hub item put --stdin`, then `hub source <name> --cursor <c>`. `hub items --needs-me` is what waits on the user.
Drafts for humans to post: `hub draft <id> "<label>" --stdin`; when posted: `hub posted <id> "<label>" --channel "<where>" --ref <permalink> --stdin` with the wording actually sent.
Daily plan: `hub day` to resume; `hub day set <date> --file <plan.md>` after writing it.
Longer content: `hub note <id> "<title>" --file <path>`.
State fields are one line each; the CLI refuses more and says where the text belongs.
```

## Development

```sh
npm ci
npm run type-check && npm run lint && npm test
```

## License

Apache-2.0
