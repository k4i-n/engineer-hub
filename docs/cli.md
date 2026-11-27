# CLI

## Commands

Every read takes `--json`. Errors are one line on stderr with exit 1; an unknown command prints usage and exits 2.

| Read | Prints |
|---|---|
| `hub ticket <id>` | state with the state of each attached PR (`#140 approved`), tracker fields, step progress and the steps being done, the last 3 events, open drafts, open items and waits, note titles (under 25 lines) |
| `hub board [regex]` | open tickets grouped by dir, one line each; `PR` shows the attached PRs with their state (`#140 approved, #141 checks failing`), else the `prs` text |
| `hub next` | the next action of each ticket in progress, then to do, in your order, then by tracker priority |
| `hub gates` | tickets waiting on a human decision |
| `hub changed --since <date\|yesterday\|today>` | events and state changes since a day |
| `hub search <query> [-n 10]` | full-text search over tickets, notes, events and drafts |
| `hub events <id> [-n 20] [--full]`, `hub notes <id>`, `hub note-show <id> <title>` | timeline and notes |
| `hub drafts [id]`, `hub draft-show <id> <label>` | messages for humans to post; `id` is a ticket, or an item's url or ref for the drafts on that item |
| `hub items [--needs-me] [--source <s>] [--ticket <id>] [--all]` | open items (PRs, threads, review requests, alerts…), the ones that need you first |
| `hub waits [--due]` | questions asked of someone; `--due` lists the ones to ping now |
| `hub sources` | each source's last sync, cursor and error |
| `hub steps <id>` | the ticket's steps (`[ ]` todo, `[>]` doing, `[x]` done), with their evidence |
| `hub brief` | what a sync needs to judge new messages: sources and cursors, open tickets, unsent drafts, drafts sent with wording pending, waits, tracked items (each section capped at 40 lines) |
| `hub day [date] [--full]` | the rev, the RESUME block and the Today lines of a day plan (today, else the latest), each line with its live state; `--full` gives the whole plan with the lines under `## Today`. Today's plan ends with `## From hub`, generated from the database: my open PRs with their state, open waits with their ping time, drafts set to send later, and open gates |
| `hub lint` | open tickets missing status, next or owner, over a limit, with a gate that is not a question (no `?`) or that offers a choice (`A or B?`: a gate is a yes/no question; options go in the ticket), or with a title that starts with the ticket's id; exit 1 if any |
| `hub config [key]` | effective config |

| Write | Does |
|---|---|
| `hub set <id> <field> <value>` | field is title, status, repo, worktree, branch, gate, next, owner, priority (Urgent, High, Medium or Low; empty clears it, and a Linear ticket's priority follows Linear) or updated (when the ticket last moved, `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, not in the future: dates backfilled history; any other set stamps now) |
| `hub merge <id> <into id>` | moves the ticket's timeline, notes, drafts, steps (numbered after the other ticket's), items and waits into the other ticket and deletes it; a clashing note title or draft label gets ` (from <id>)`, and a later write to the old id names the one it went into. Backs up first as `…-before-merge.db`; not an MCP tool |
| `hub ticket-delete <id>` | deletes the ticket with its timeline, notes, drafts, steps and waits; its items stay, unattached. Backs up first as `…-before-delete.db` (`hub restore` brings it back); not an MCP tool |
| `hub rename <id> <new id>` | changes the ticket's id (a `NEW-` ticket to its tracker id once filed); its timeline, notes, drafts, steps, items, waits and pins follow, and a later write to the old id fails naming the new one |
| `hub log <id> <text> [--kind log] [--source agent] [--ref <url>]` | adds an event stamped in the configured timezone |
| `hub note <id> <title> (--file <path> \| --stdin) [--kind detail]` | adds or replaces a note |
| `hub draft <id> <label> (--file \| --stdin) [--channel <c>] [--send-at <when>] [--item <url>] [--internal]` | adds or replaces a draft; `--send-at` takes `30m`, `4h`, `tomorrow`, `12:00`, `tomorrow 12:00` or `2026-11-20 12:00`. `--item` names the PR, review request or message it answers (kept when left out, `""` clears it); that row on the dashboard shows the draft with Copy and Sent while it is open; any other unsent draft is a Send row under Reply. `--internal` marks text an agent uses itself (a PR body): it shows on the ticket page only and is kept on a later save without the flag (API and MCP `internal: false` clears it). A new draft whose first line is `Title: …`, or whose channel names a PR or branch, is internal without the flag. When a PR attached to the ticket has that title, the draft is marked posted with the PR's url and body; `hub posted` on such a draft with no wording takes the PR's body. With no ticket, `<id>` is the item's url or ref; every draft command then takes that url in place of the ticket id. A PR review also takes `--verdict approve\|request_changes\|comment` and `--comments <file>`, a JSON list of `{"path", "line", "body"}` that replaces the draft's comments (`[]` clears them, `--verdict ""` clears the verdict); `hub draft-show` prints them after the body. Hub never posts the review |
| `hub draft-later <id> <label> [--for <when>]` | moves a draft's send time (default tomorrow) |
| `hub posted <id> <label> [--at <when>] [--channel <c>] [--answer <text>] [--ref <url>] [--file \| --stdin]` | marks a draft posted or answered; the text given is the wording actually sent, which may differ from the draft (without it the draft shows "wording pending"). A draft on an open review request also marks the request done |
| `hub unposted <id> <label>` | marks a sent draft not sent again, dropping its sent wording, permalink and answer, and reopens the review request its Sent closed |
| `hub link <id> <url> [--kind <k>] [--title <t>]` | attaches the URL to the ticket as an item; source and kind come from the URL |
| `hub match <id> <label> --ref <url> (--file \| --stdin)`, `hub match <id> <label> (yes \| no)` | proposes a sent message as the wording of a draft when the agent is unsure; yes marks the draft posted with it, no drops it |
| `hub step add <id> <title> [--at <n>]`, `hub step start <id> <n>`, `hub step done <id> <n> [--evidence <url>]` | adds a step (at the end, or at place n with the rest moving down), marks one doing when work on it begins (several can be doing; one waiting on review or merge is still doing), marks one done (from todo or doing) and logs each |
| `hub step edit <id> <n> <title>`, `hub step undo <id> <n>`, `hub step rm <id> <n>` | changes a step's title, marks a done step not done or a doing step not started (logged; both go back to todo), removes a step (the rest move up, so steps stay 1 to n) |
| `hub note-mv <id> <title> <new title>`, `hub note-rm <id> <title>` | renames or removes a note |
| `hub draft-mv <id> <label> <new label>`, `hub draft-rm <id> <label>` | renames a draft, or removes one never sent (a sent draft stays as the record) |
| `hub item put --stdin` | stores items read from a source, one JSON object per line ([format](sources.md#items-from-connectors)) |
| `hub item close <item>...`, `hub item snooze <item> [--for 1d|tomorrow]`, `hub item attach <item> <id>`, `hub item detach <item>` | marks items handled, hides one for a while (a change brings it back), attaches one to a ticket, takes one off its ticket (a later fetch does not match it back by id; attach does); `<item>` is the `#` number or the ref |
| `hub item ask <item> <question>`, `hub item answer <item> (yes \| no)`, `hub item unanswer <item>` | puts a one-line yes/no question on an item (an empty question removes it), answers it, takes the answer back; the question and answer show in `hub items`, the brief and on the item's row. Review requests ask "Review this?" by themselves (No closes them); agents ask other questions (`item_ask`); only the human answers |
| `hub item ignore <item>`, `hub item unignore <item>` | never shows the item again, whatever changes (it stays in `hub items --all`); to leave out a whole repo, add it to `skipRepos` |
| `hub wait <id> <who> <url> [--ping-after 1d]`, `hub wait close <wait \| url>` | records a question asked of someone, closes it when they answer |
| `hub wait edit <wait> [--who <w>] [--ping-after 1d]` | changes who an open wait is on, or when to ping |
| `hub source <name> [--cursor <c>] [--error <text>]` | records a sync of a source |
| `hub slack add <workspace>`, `hub slack remove <workspace>` | adds a [Slack workspace](sources.md#sources-hub-fetches-itself) as the source `slack-<workspace>` with the key `slack-<workspace>` (also Settings → Sources), removes one |
| `hub source add <name> --every 5m -- <program> [args]`, `hub source set <name> [--on \| --off] [--every 5m] [--section <title>]`, `hub source remove <name>` | adds a [script source](sources.md#script-sources) (terminal only), turns one off or on, changes its interval or the dashboard card its items go to, removes one |
| `hub day set <date> (--file \| --stdin) [--rev <rev>]` | stores a day plan's body (RESUME, notes, decisions); replacing one needs the rev `hub day` showed, and a stale rev is refused. A body with task lines (`- [ ]`) under `## Today` is refused: those are plan lines; so is a `## From hub` section, which `hub day` generates. The first write of a date carries the open, not dropped lines of the latest earlier plan and lists them |
| `hub plan add <text> [--ref "<ref> ..."] [--time HH:MM] [--at <n>]` | adds a line to the day's plan (`--date`, default today). A ref points the line at a row, and the line ticks itself when that row is done: `step:<id>#<n>` (step done; kept by the step itself, so renumbering does not move it), `draft:<id or item url>/<label>` (sent; a proposed match shows `sent?` and stays open), `item:<n or url>` or a bare url (closed, merged or done), `wait:<n>` (answered), `gate:<id>` (the human answers it after the line was added), `ticket:<id>` (moved to done). With several refs, all must be done. A ref that names nothing is refused; text that names a ticket with no ref gets a warning. Lines need no rev, so two sessions can add at once |
| `hub plan edit <n> [text] [--ref <refs>] [--time HH:MM]`, `hub plan move <n> <to>` | changes line n (its place in `hub day`), or moves it; `--ref ""` or `--time ""` clears |
| `hub plan done <n>`, `hub plan undo <n>`, `hub plan drop <n> <why>` | ticks or unticks a line without refs (on a line with refs it is refused and names the action that ticks it, e.g. `step_done ENG-7 2`), drops a line that slipped or was cancelled (struck through with the reason, never carried over; `undo` brings it back) |
| `hub ticket-new <id> <title> [--dir todo]`, `hub move <id> <dir>` | creates a ticket, moves it between dirs (a move drops its place in the order) |
| `hub backup`, `hub backups` | backs up the database now, lists the backups newest first |
| `hub restore <name>` | backs up the current database as `…-before-restore.db`, then replaces it with the named backup while hub keeps running; a backup made in the same second as another gets `-2`, `-3` |
| `hub order <id> <place \| ->` | puts the ticket at a place in its dir (1 is the top); tickets above it keep their places and the rest shift down; `-` takes it out of the order. Ordered tickets come first in `hub board`, `hub next` and the dashboard, as `#1`, `#2`…, then the rest by tracker priority |
| `hub config <key> <json>` | stores a config value, checked against the default's type |

## Limits

State fields are one line. Status, repo, gate and next are capped at 240 characters and owner at 120. `hub set` refuses longer values and names the place for the detail:

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
| `syncCommand` | `claude -p /engineer-hub:hub-sync …` | the agent run that Sync → Agent, Sync → All and auto sync start; any headless agent CLI |
| `autoSync` | `false` | run the agent every `syncEvery` after its last run |
| `syncEvery` | `4h` | 5m to 8h |
| `fetchEvery` | `1m` | how often built-in sources fetch, 1m to 60m |
| `layout` | `{"top":["overview"],"left":[…],"right":[…]}` | where each dashboard card sits |
| `hiddenBlocks` | `[]` | dashboard cards that are hidden |
| `progressStyle` | `"ring"` | step progress as `ring`, `half` or `bar` |
| `horizon` | `"14d"` | the period for Steps done, the Done tab, the done count and Activity: `7d`, `14d`, `30d`, `week`, `month` or `all` |
| `githubReviewQuery` | `"is:pr is:open review-requested:@me archived:false draft:false"` | the GitHub search for review requests |
| `issueRepo` | `""` | `owner/name` a note's "Open as GitHub issue" files into when the ticket's `repo` is not one |
| `githubPrQuery` | `"is:pr author:@me"` | the GitHub search for your PRs (hub adds `updated:>=` the last fetch) |
| `skipRepos` | `[]` | repos (`owner/name`) left out of both GitHub searches as `-repo:` terms |
| `slackAlertChannels` | `[]` | Slack channels whose new messages are alerts (Fix now); give names or ids, stored as `{"id","name"}` |
| `slackIgnoreChannels` | `[]` | Slack channels hub pulls nothing from; same form as `slackAlertChannels` |
| `slackGroupChannels` | `[]` | the only Slack channels where a mention of a user group you are in is pulled; empty pulls none; same form as `slackAlertChannels` |
| `slackWatchChannels` | `[]` | Slack channels whose every new message from others needs you (Reply), with or without a mention; same form as `slackAlertChannels` |
| `laterHour` | `9` | the hour "later until tomorrow" means |
| `recordActions` | `git push`, `gh pr create\|merge\|comment\|review\|close\|edit`, `gh issue create\|comment\|close\|edit` | regular expressions for shell commands a session must record in hub before it stops, and whose printed PR the PostToolUse hook links to the ticket on the current branch; `[]` switches the Stop hook off |
| `awayPing` | `false` | post to a webhook when new alerts or messages arrive while you are away (see Dashboard) |
| `awayAfter` | `"10m"` | idle time that counts as away, 1m to 60m; a locked screen is away at once |
| `awayEvery` | `"30m"` | at most one post per this long, 5m to 4h |
| `judgeCommand` | `claude -p --model haiku --max-turns 1 --tools "" …` | the one-shot command that picks which new items are worth an away ping (terminal only); `[]` posts counts instead |
| `judgePrompt` | ping questions, requests, blockers and alerts that match a ticket or a recent merge; skip thanks, FYI, routine alerts, bot updates | the rules the judge gets |
| `watchFor` | `"3h"` | how far back the judge sees your merged PRs, 30m to 24h |
| `autoBackup` | `true` | back up the database on a schedule |
| `backupEvery` | `"1d"` | how often, 1h to 7d |
| `backupDir` | `""` | backup folder, absolute or `~/…`; empty means `backups/` next to the database |
| `backupKeep` | `14` | backups kept, 1 to 100; older ones are deleted |
| `stateFields`, `sections`, `trackerSyncMarkers`, `planDir`, `resumeHeading` | | markdown conventions the importer reads |

## Import from a markdown ticket folder

```sh
hub import --root ~/work/agent           # dry run: counts and findings
hub import --root ~/work/agent --apply   # writes; a second --apply reports changes: 0
```

The importer reads, and never writes:

- `tasks/<dir>/**/<id>*.md`: a `Status:` / `Repo:` / `Next:` … state block (`Order: 2` or `Order: P2` is the ticket's place, as `hub order` sets it), `## Log` entries (`- 2026-11-12 14:20: text`), `## Messages` drafts (`### label`), and a tracker block between the sync markers.
- `plan/plan-YYYY-MM-DD.md`: day plans.
- every other file under `tasks/<dir>/` that names a ticket id or sits in a folder named after one (`ENG-42-baseline.md` next to `ENG-42-session-sync.md`, `ENG-7-notes-draft.md`, `ENG-7-scripts/notes.md`): one markdown file per id is the ticket (the one with a state block, else the first), each other markdown file becomes a note on it titled with its path, and other files are listed by path in its `Other files` note. The dry run lists what it folded and every file that matched no ticket.

Every section lands in the database. Other headings become notes. A state field over its limit is cut and its full text kept in a `State notes` note. A ticket file that does not start with `# <id> - <title>` is titled from its file name without the id (`ENG-9-retire-old-watch.md` → "retire old watch"), and the report lists those tickets; Linear's title replaces such a title on the next fetch. After the import, move the markdown folder to a backup: from then on the database is the only source of truth.
