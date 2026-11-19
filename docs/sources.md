# Sources

## Sources hub fetches itself

`hub serve` fetches its built-in sources on a timer (every minute; Settings → Sources, config `fetch` and `fetchEvery`), with no Claude session and no plan quota. `hub fetch [source]` runs them now.

| Source | Fetches | Credential |
|---|---|---|
| `github` (on by default) | review requests found by the `githubReviewQuery` search (closed when no longer found), your PRs updated since the last fetch with review decision and checks: approved, changes requested and checks failing need you | none in hub: it runs your signed-in `gh` |
| `linear` | issues assigned to you updated since the last fetch (a new one with no hub ticket needs you; done and canceled do not), and mentions of you in issues and comments; an issue whose id is a hub ticket also sets that ticket's tracker state, priority, assignee, link and update time (what `board`, `next` and the `[TRACKER: …]` warning read) | a personal API key with read access |
| `slack` | messages that mention you (need you), messages you sent (state `sent`, for an agent to match to drafts), and replies or a reaction from someone else on your message in threads you wait on (the wait closes and the answer needs you). Slack markup reads as text: `<@U…>` as `@name`, `<#C…>` as `#channel`, groups, `@here` and links; DMs and group DMs are named. Your own ✅ (`white_check_mark`, `heavy_check_mark`, `ballot_box_with_check`, `done`) on a mention takes it off your list; another reaction of yours shows as its state. Your later reply in the mention's thread also takes it off, with state `replied`; `hub item put` with `needs_me: true` puts it back. Not yet: DMs that do not mention you | a user token (`xoxp-`) |

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

The second group of scopes is optional: a scope the token lacks (or an endpoint the sealcall route does not allow) only leaves that detail out, ids stay ids, and the source shows an amber warning naming the missing scopes in the header and in Settings → Sources. Adding a scope to an installed app needs a reinstall, which issues a new token; store it again (`sealcall rotate slack` keeps the route).

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
