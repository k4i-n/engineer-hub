---
name: hub-sync
description: Judge what hub fetched but cannot decide by rule (the engineer's sent Slack messages against drafts, items to attach to tickets), and read the sources hub does not fetch itself (mail, and any source with a connector but no built-in) into the local hub record with the hub MCP tools, read only. Use when asked to sync hub, refresh the dashboard, check what is new, or before planning the day.
---

# hub-sync

hub fetches GitHub, Linear, Slack and script sources by itself every few minutes. This skill does only what needs judgment, and reads only the sources hub does not fetch. Use the hub MCP tools (`mcp__plugin_engineer-hub_hub__*`, below by their short names). Never write to a source: no posting, replying, reacting, commenting, marking read, assigning or changing state. The only writes are hub tool calls.

## 1. Context

Call `brief`. Its first line names the sources hub fetches itself: never read those. It also lists unsent drafts, drafts sent with wording pending, open waits, tracked items, and "to judge": the engineer's own sent messages hub fetched.

## 2. Judge the sent messages

For each row under "to judge" (its title is `#channel author: text`, then the permalink):

| The message | Record |
|---|---|
| Clearly an unsent draft's message: same channel or thread, same person, same ask, in any wording | `posted` with `id`, `label`, `channel`, `sent_ref` (the permalink), `sent_text` (the message as sent) |
| Fills a draft whose wording is pending | the same call; it keeps the posted time and adds the wording |
| Might be a draft's message but you are not sure | `match` with `id`, `label`, `sent_text`, `sent_ref`; the engineer answers yes or no on the dashboard |
| No draft, but clearly about a known ticket | `log` with `id`, `text` (one line: what was said, to whom), `kind: "slack"`, `source: "sync"`, `ref` |
| Anything else | `item_close` the row |

Hub matches the engineer's own GitHub reviews to drafts on that PR itself; leave those drafts alone. Match by meaning, never by exact text: the engineer often rewrites drafts. A call that names the message's permalink (`posted`, `match`, `log` with `ref`) closes its row; otherwise close it as the table says, so it is not judged again.

## 3. Attach

For each tracked item with no ticket whose title or link clearly belongs to an open ticket from the brief, `item_attach` it. When unsure, leave it.

For each open review request with no `ask:` in its brief line, `item_ask` with `question: "Review this?"`. An answer shows as `ask: Review this? yes` (or `no`) and under "from you"; review only on yes, never answer it yourself.

## 4. Sources hub does not fetch

Only for sources not named in the brief's first line, and only through a connector this session has. Read the delta since the source's cursor (no cursor: the last 2 days). A source with no connector: `source_status` with `name` and `error: "no connector"`. A failed read: `source_status` with the `error` and no `cursor`, then go on.

- **mail** (Gmail or the mail connector): mail to the engineer since the cursor from a person, not a newsletter, notification or bulk sender: a `mail` item, `needs_me: true` when it asks for something; alert mail: an `alert` item. Cursor: the time this sync started.
- **github, slack, tracker** only when hub does not fetch them: the same items hub's built-ins write (review requests and the engineer's PRs; mentions, and the engineer's own messages judged as in step 2; issues assigned and mentions), through the connector.

Write each source's items in one `item_put` call, then `source_status` with `name` and `cursor`.

## 5. Finish

Reply with one line, for example `judged 3 (2 posted, 1 match) | attached 1 | mail: 2 new`, and nothing else.
