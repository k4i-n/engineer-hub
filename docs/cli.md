# CLI

## Commands

Every read takes `--json`. Errors are one line on stderr with exit 1; an unknown command prints usage and exits 2.

| Read | Prints |
|---|---|
| `hub ticket <id>` | state, tracker fields, step progress and the next step, the last 3 events, open drafts, open items and waits, note titles (under 25 lines) |
| `hub board [regex]` | open tickets grouped by dir, one line each |
| `hub next` | the next action of each ticket in progress, then to do, in your order, then by tracker priority |
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
| `hub item put --stdin` | stores items read from a source, one JSON object per line ([format](sources.md#items-from-connectors)) |
| `hub item close <item>...`, `hub item snooze <item> [--for 1d|tomorrow]`, `hub item attach <item> <id>` | marks items handled, hides one for a while (a change brings it back), attaches one to a ticket; `<item>` is the `#` number or the ref |
| `hub item ignore <item> [--repo]`, `hub item unignore <item> [--repo]` | never shows the item again, whatever changes (it stays in `hub items --all`); `--repo` ignores every review request, or every PR of yours, from its repo, now and later (config `ignoreRepos`) |
| `hub wait <id> <who> <url> [--ping-after 1d]`, `hub wait close <wait \| url>` | records a question asked of someone, closes it when they answer |
| `hub source <name> [--cursor <c>] [--error <text>]` | records a sync of a source |
| `hub day set <date> (--file \| --stdin)` | stores a day plan |
| `hub ticket-new <id> <title> [--dir todo]`, `hub move <id> <dir>` | creates a ticket, moves it between dirs (a move drops its place in the order) |
| `hub order <id> <place \| ->` | puts the ticket at a place in its dir (1 is the top); tickets above it keep their places and the rest shift down; `-` takes it out of the order. Ordered tickets come first in `hub board`, `hub next` and the dashboard, as `#1`, `#2`…, then the rest by tracker priority |
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
| `githubReviewQuery` | `"is:pr is:open review-requested:@me archived:false"` | the GitHub search for review requests |
| `ignoreRepos` | `{"review_request":[],"pr":[]}` | repos whose review requests or PRs of yours are ignored |
| `laterHour` | `9` | the hour "later until tomorrow" means |
| `stateFields`, `sections`, `trackerSyncMarkers`, `planDir`, `resumeHeading` | | markdown conventions the importer reads |

## Import from a markdown ticket folder

```sh
hub import --root ~/work/agent           # dry run: counts and findings
hub import --root ~/work/agent --apply   # writes; a second --apply reports changes: 0
```

The importer reads, and never writes:

- `tasks/<dir>/**/<id>*.md`: a `Status:` / `Repo:` / `Next:` … state block (`Order: 2` or `Order: P2` is the ticket's place, as `hub order` sets it), `## Log` entries (`- 2026-11-12 14:20: text`), `## Messages` drafts (`### label`), and a tracker block between the sync markers.
- `plan/plan-YYYY-MM-DD.md`: day plans.

Every section lands in the database. Other headings become notes. A state field over its limit is cut and its full text kept in a `State notes` note. After the import, move the markdown folder to a backup: from then on the database is the only source of truth.
