---
name: hub-sync
description: Sync what is new for the engineer from GitHub, Slack, the issue tracker and mail into the local hub record (the `hub` CLI), reading each source through the connector or CLI already available, read only. Use when asked to sync hub, refresh the dashboard, check what is new, or before planning the day.
---

# hub-sync

Read only what changed since the last sync, judge it against `hub brief`, and record it with `hub` commands. Never write to a source: no posting, replying, reacting, commenting, marking read, assigning or changing state. The only writes are `hub` commands.

## 1. Context

```sh
hub brief
```

It lists each source's cursor, open tickets, unsent drafts, drafts sent with wording pending, open waits and tracked items. Keep it in mind; read nothing else from hub unless a case below needs it.

## 2. Each source

For each source below that has a connector or CLI in this session, read the delta since its cursor (no cursor: the last 2 days). Skip a source with no connector and record `hub source <name> --error "no connector"`. If a read fails, record `hub source <name> --error "<short reason>"` without `--cursor` and go on with the next source.

Collect items and write them in one call per source:

```sh
hub item put --stdin <<'JSONL'
{"source":"github","kind":"review_request","url":"…","title":"…","state":"open","author":"…","needs_me":true}
JSONL
```

Put `ticket` only when you know the ticket and its id is not already in the title or URL. Leave out keys you do not know; a missing key keeps what hub has.

### github (`gh`, or the GitHub connector)

- Review requests: `gh search prs --review-requested=@me --state=open --json url,title,author,updatedAt`. Each is a `review_request` with `needs_me: true`.
- Then go through every `github/review_request` line in the brief's tracked list. Each one whose url is not in that search result is no longer requested: put it with `"state":"done","needs_me":false`. Do not skip this; it is how a finished review leaves the dashboard.
- The engineer's PRs updated since the cursor: `gh search prs --author=@me --updated=">=<cursor date>" --json url,title,state` then `gh pr view <url> --json state,reviewDecision,mergedAt` for each. Kind `pr`, state `open`, `approved`, `changes requested`, `merged` or `closed`. `needs_me: true` for approved or changes requested.
- Cursor: the time this sync started, ISO 8601.

### slack (the Slack connector)

Two searches since the cursor: messages from the engineer, and messages to the engineer (mentions, DMs, replies in threads the brief tracks or waits on). Then for each message:

| Message | Record |
|---|---|
| The engineer's message that is clearly an unsent draft's message: same channel or thread, same person, same ask, in any wording | `hub posted <id> "<label>" --channel "<channel>" --ref <permalink> --stdin` with the message text as sent |
| The engineer's message that fills a draft with wording pending | the same command; it keeps the posted time and adds the wording |
| Might be a draft's message but you are not sure | `hub match <id> "<label>" --ref <permalink> --stdin`; the engineer answers yes or no on the dashboard |
| The engineer's message with no draft, on a known ticket | `hub log <id> "<one line: what was said, to whom>" --kind slack --source sync --ref <permalink>` |
| A reply in a thread of an open wait | `hub log <id> "<who> answered: <one line>" --kind slack --source sync --ref <permalink>`, then `hub wait close <thread url>`, and a `thread` item with `needs_me: true` |
| A mention or DM asking the engineer something | a `message` item, `needs_me: true` |
| An alert or incident message | an `alert` item, `needs_me: true` |
| Anything else | nothing |

Match drafts by meaning, never by exact text: the engineer often rewrites them. Cursor: the newest message timestamp read.

### tracker (Linear, Jira or the tracker connector in the session)

Issues assigned to the engineer updated since the cursor: an `issue` item each, url as ref, state as the tracker names it. A new issue assigned to the engineer with no hub ticket: `needs_me: true`. Comments that mention the engineer: a `message` item with `needs_me: true`. Cursor: the time this sync started.

### mail (Gmail or the mail connector)

Mail to the engineer since the cursor from a person, not a newsletter, notification or bulk sender: a `mail` item, `needs_me: true` when it asks for something. Alert mail: an `alert` item. Cursor: the time this sync started.

## 3. Finish

For each source read without error: `hub source <name> --cursor <cursor>`. Then reply with one line per source, for example `github: 2 new, 1 changed | slack: 1 posted, 1 wait closed`, and nothing else.
