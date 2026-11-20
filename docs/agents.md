# Agents

## Claude Code plugin

The repository is a Claude Code plugin: the hub MCP server and two skills.

- `.mcp.json` connects to `${HUB_URL:-http://127.0.0.1:7420}/mcp`; its `headersHelper` runs `hub mcp-headers`, which prints the bearer header from the token next to the database (`HUB_DB`), so no token sits in a config file or the environment. `alwaysLoad` makes a headless `claude -p` wait for the hub tools before it starts.
- `hub-sync`: the judgment hub cannot do by rule: matches your sent Slack messages to drafts by meaning (posted, or a match for you to confirm), attaches items to tickets, and reads the sources hub does not fetch itself (mail, and any source with a connector but no built-in), read only, through the hub tools.
- `hub-plan`: syncs, then writes the plan for today with `day_set`.

```
/plugin install engineer-hub --marketplace nhkhai-vn/engineer-hub
```

Tools show as `mcp__plugin_engineer-hub_hub__<tool>`; allow the whole server with `mcp__plugin_engineer-hub_hub`.

The plugin's hooks tell every Claude Code session what moved, without a tool call: at session start a one-line count (`hub: 3 need you: 2 review requests, 1 alert; 1 ping due.`), and before each prompt the new or changed items that need you, mentions you replied to (`replied:`, off your list), answered waits, pings that came due and your dashboard clicks since that session's last look (nothing when nothing moved, or when hub is not running). Each session keeps its own mark. The same from a shell: `hub moved --as <session id> [--start]`.

A Stop and SubagentStop hook (`hub record-gate --hook`) blocks a session that ran a command matching `recordActions` (by default `git push`, `gh pr create|merge|comment|review|close|edit` and `gh issue create|comment|close|edit`) and wrote nothing to hub after it, listing the last commands and asking it to log or link them and set the ticket's next. It checks that a hub write came after the action, not that it was the right one, and it fires once per stop. Heredoc bodies are ignored, but other quoted text is not.

A PostToolUse hook (`hub record --hook`) records most of these without the agent: when a `recordActions` command prints a GitHub PR URL that no ticket has yet, and exactly one ticket has the checkout's current branch as its `branch`, it links the PR to that ticket and tells the agent so. An action whose printed PR is linked in hub no longer blocks the stop. Nothing is written when no ticket or more than one has that branch.

## For agents

With the hub MCP tools connected (plugin or `/mcp`), put this in the agent's instructions; the server's MCP instructions say the same in short:

```
Cold start for a ticket: brief, then board or ticket. Read a note only when the next action needs it (note).
During work: log what changed, readings and decisions; ticket_set next (one action) and gate (a decision waiting on the human); link every PR, run, thread or doc touched.
Waiting on someone: wait_add with ping_after; waits with due says whom to ping.
Drafts for humans to post: draft_save; a review or reply to a PR, review request or message gets item (its url), and id is that url when there is no ticket; a PR review adds verdict and comments [{path, line, body}]; text for the agent's own use (a PR body) gets internal: true, so it stays off the dashboard; when posted: posted with the wording actually sent and its permalink.
Daily plan: day to resume; day_set after writing it. To change an existing plan: day with full, merge, day_set with its rev. Longer content: note_save.
State fields are one line each; hub refuses more and says where the text belongs. Never answer a gate, a draft match or an item question for the human.
```

Without MCP, the same through the CLI: `hub ticket`, `hub log`, `hub set`, `hub link`, `hub wait`, `hub draft`, `hub posted`, `hub day set`, `hub note`.

## MCP

`hub serve` is also an MCP server (streamable HTTP) at `http://127.0.0.1:7420/mcp`, with the same bearer token. Its tools are the API's routes for agents (`brief`, `board`, `ticket`, `ticket_set`, `log`, `item_put`, `wait_add`, `draft_save`, `posted`, `match`, `step_done`, ...), each read-only or marked when it replaces data. Tools never answer for the human: there is no gate answer, no match answer, no pin, config or Sync. The Claude Code plugin above connects it for you. For any other agent that speaks MCP:

```json
{ "mcpServers": { "hub": { "type": "http", "url": "http://127.0.0.1:7420/mcp", "headers": { "Authorization": "Bearer ${HUB_TOKEN}" } } } }
```

with `HUB_TOKEN=$(cat ~/.hub/token)` in the environment, or a `headersHelper` of `hub mcp-headers` where the client has one.

## API

`hub serve` answers a JSON API at `http://127.0.0.1:7420/api/v1/`, the same reads and writes as the CLI with the same checks and limits; the dashboard uses it too. `/api/v1/openapi.json` lists every route. Send the token file next to the database as a bearer token:

```sh
curl -H "Authorization: Bearer $(cat ~/.hub/token)" http://127.0.0.1:7420/api/v1/tickets/ENG-42
curl -H "Authorization: Bearer $(cat ~/.hub/token)" -H "Accept: text/plain" http://127.0.0.1:7420/api/v1/next
curl -X PATCH -H "Authorization: Bearer $(cat ~/.hub/token)" -H "Content-Type: application/json" \
  -d '{"next":"open the PR","gate":"-"}' http://127.0.0.1:7420/api/v1/tickets/ENG-42
```

What you click on the dashboard (done, later, answered, sent, a match answer) is recorded as a `human` event, and `brief` lists those since the previous brief under "from you", so an agent learns them without opening each ticket. An item answer reads `answered: #509 Review this? yes (acme/web#1710)`, also on an item with no ticket, and `moved` lists it once. An agent does not ask on review requests: hub asks `reviewAsk` on each new one, and the agent acts on the answer from `moved` or `brief`. `item_ask` stays for other questions. Responses are the CLI's `--json` output, or its text with `Accept: text/plain` (the CLI's exit code is in `x-hub-exit`). Writes take a JSON body; an unknown, missing or mistyped field is refused with `400 {"error": ...}`. A ticket `PATCH` applies all its fields or none. Config keys that run commands (`syncCommand`) are set from the terminal only.
