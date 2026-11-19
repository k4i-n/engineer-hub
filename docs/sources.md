# Sources

## Sources hub fetches itself

`hub serve` fetches its built-in sources on a timer (every minute; Settings → Sources, config `fetch` and `fetchEvery`), with no Claude session and no plan quota. `hub fetch [source]` runs them now.

| Source | Fetches | Credential |
|---|---|---|
| `github` (on by default) | review requests found by the `githubReviewQuery` search (closed when no longer found), your PRs updated since the last fetch plus every stored PR not yet merged or closed (looked up by URL, so a merge search missed and a PR linked to a ticket still get their state; someone else's PR never needs you), each attached to the ticket whose id is in its title, branch name or body, with a status from draft, review decision, latest reviews and checks: changes requested, checks failing, approved and commented need you; draft and in review do not | none in hub: it runs your signed-in `gh` |
| `linear` | issues assigned to you updated since the last fetch (a new one with no hub ticket needs you; done and canceled do not), mentions of you in issues and comments, and new comments from others on issues assigned to you or whose id is a hub ticket (state `comment`, a Reply that needs you, on the ticket's timeline); an issue whose id is a hub ticket also sets that ticket's tracker state, priority, assignee, link and update time (what `board`, `next` and the `[TRACKER: …]` warning read) | a personal API key with read access |
| `slack` | messages that mention you, DMs and group DMs sent to you (state `dm`) and replies from others in threads you posted in during the last 3 days (state `reply`, the 20 latest threads), all needing you; new messages in the channels listed in `slackAlertChannels` (alerts: Fix now, until your ✅), messages you sent (state `sent`, for an agent to match to drafts), and replies or a reaction from someone else on your message in threads you wait on (the wait closes and the answer needs you). Slack markup reads as text: `<@U…>` as `@name`, `<#C…>` as `#channel`, groups, `@here` and links; DMs and group DMs are named. Your own ✅ (`white_check_mark`, `heavy_check_mark`, `ballot_box_with_check`, `done`) on a mention takes it off your list; another reaction of yours shows as its state. Your later reply in its thread, or any later message of yours in that DM, also takes it off, with state `replied`; `hub item put` with `needs_me: true` puts it back. DMs come from a `to:` search, which Slack's help does not list | a user token (`xoxp-`) |

The review request search defaults to `is:pr is:open review-requested:@me archived:false` and takes any GitHub search filter. Change it in Settings → Sources, where the active search is shown, or from the terminal:

```sh
hub config githubReviewQuery '"is:pr is:open review-requested:@me archived:false -repo:acme/noisy-repo"'
```

A source that fails shows its reason in Settings and in the header, with the command that fixes it. Sources with an API key call through sealcall when `sealcall routes` lists a route named after the source, so hub never sees the key; otherwise hub reads its own Keychain item `engineer-hub/<source>` (`HUB_<SOURCE>_KEY` off macOS), which any process running as you can read. For Linear:

```sh
security add-generic-password -s engineer-hub -a linear -w     # hub's own item; paste the key at the prompt
sealcall add linear --host api.linear.app --header 'Authorization: {key}' --allow 'POST /graphql'   # or sealcall
hub config fetch '{"github":true,"linear":true}'
```

For Slack, create an app in your workspace (api.slack.com/apps → From scratch), add the user token scopes `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, plus for names, DMs and reactions `users:read`, `usergroups:read`, `channels:read`, `groups:read`, `im:read`, `mpim:read` and `reactions:read`, install it to the workspace (some workspaces need an admin to approve), and store the User OAuth Token from the install page:

```sh
security add-generic-password -s engineer-hub -a slack -w      # paste the xoxp- token
sealcall add slack --host slack.com --header 'Authorization: Bearer {key}' \
  --allow 'GET /api/auth.test' --allow 'GET /api/search.messages' --allow 'GET /api/conversations.replies' \
  --allow 'GET /api/conversations.info' --allow 'GET /api/users.info' --allow 'GET /api/usergroups.list' \
  --allow 'GET /api/reactions.get'   # or sealcall
```

To watch alert channels, list them in Settings → Sources → Alert channels, or:

```sh
hub config slackAlertChannels '["alerts-prod","oncall"]'
```

Every new message there from someone other than you, bot posts included, is an alert that needs you; a bot post with no text uses its first attachment's title. Your ✅ on it takes it off; replying in its thread does not. Each channel is one more `search.messages` call per fetch (Slack allows about 20 a minute), and a private channel needs you to be a member.

The second group of scopes is optional: a scope the token lacks (or an endpoint the sealcall route does not allow) only leaves that detail out, ids stay ids, and the source shows an amber warning naming the missing scopes in the header and in Settings → Sources. Adding a scope to an installed app needs a reinstall, which issues a new token; store it again (`sealcall rotate slack` keeps the route).

### Script sources

For a service hub has no built-in for, a small script of yours runs on its own timer:

```sh
hub source add pagerduty --every 5m -- node examples/sources/pagerduty.mjs
hub fetch pagerduty
hub source remove pagerduty
```

hub runs the program and its arguments with no shell, a 2 minute timeout and `HUB_SINCE` set to the start of its last good run, and reads one item JSON object per line from stdout (`source` defaults to the script's name). A non-zero exit or a bad line writes nothing and is the source error (with the last stderr line). Only the terminal sets the command hub runs: the API and the dashboard cannot. Settings → Sources turns a script source on or off, changes its interval, names a section for it, fetches it now or removes it (`hub source set <name> [--on | --off] [--every 5m] [--section <title>]` from the terminal), and its Add row builds the `hub source add` line for you to copy. A script source with a section puts the items that need you in a dashboard card of that name instead of the cards by kind (Fix now, Reply, Other); sources can share one, pinned items still go to Pinned, and an empty section puts them back. `examples/sources/` has PagerDuty, incident.io and Cloudflare scripts to copy; each calls through sealcall when a route with its name exists, else reads its own Keychain item, so hub never sees their keys (written from the vendors' API docs, not run against live accounts). The `hub-source` skill writes one for a named service.

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
| `ticket` | attach to this ticket; without it an id matching `ticketIdPattern` in the title or URL attaches it, else one in `context` |
| `context` | text searched for a ticket id after the title and URL, such as a PR's branch name and body; not stored (max 8000 chars) |
| `needs_me` | `true` when the item waits on you |

The batch is checked whole before anything is written. An unchanged item changes nothing. A new item on a ticket, an attach and a state change become `sync` events on the ticket. A state change or a new `needs_me` reopens a closed item.
