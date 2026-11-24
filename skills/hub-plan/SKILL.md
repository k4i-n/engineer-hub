---
name: hub-plan
description: Write the engineer's plan for today into the local hub record from what is open, waiting and new, instead of a markdown plan file. Use when asked for the plan for today, the morning plan, or what to work on next.
---

# hub-plan

The hub MCP tools (`mcp__plugin_engineer-hub_hub__*`) are named below by their short names.

1. Run the `hub-sync` skill first, unless `sources` shows a sync in the last 30 minutes.
2. Read, in this order, and nothing else unless a ticket needs it: `items` with `needs_me: true`, `waits` with `due: true`, `gates`, `next`, `day`.
3. Order the day: what blocks other people first (review requests, questions asked of the engineer, alerts), then pings that are due, then decisions waiting on the engineer, then ticket work by priority. Yesterday's open lines are carried over by the first `day_set` of the day, which lists them: `plan_drop` (with `why`) or `plan_edit` each that no longer holds.
4. Write the body into hub, never into a file: `day_set` with `date` and `body`: the RESUME block, decisions and order rules, nothing hub already holds (open PRs, waits, drafts and gates show on their own cards). If today already has a plan, read it with `day` and `full: true`, merge into it, and pass its `rev`; when `day_set` says the plan changed, read and merge again:

   ```markdown
   # Plan <YYYY-MM-DD>

   ## RESUME
   <the first thing to do, one or two lines>

   ## Today
   ```

5. Each Today line is `plan_add` with `text`, an optional `time`, and a `ref` to the row it is about, so it ticks itself when that row is done: a step (`step:<ticket>#<n>`) for ticket work, a draft (`draft:<ticket>/<label>`) for a message the engineer posts, an item (`item:<n>` or its url) for a review or a PR to merge, `wait:<n>`, `gate:<ticket>`, or `ticket:<ticket>`. Add the step first when the work has none. A line with no ref is ticked with `plan_done`. Never tick or rewrite lines in the body.
6. For each ticket worked today, keep its state in hub as the work goes: `ticket_set` with `next` (one action), `step_done` when a step finishes, `posted` when a draft is sent, `log` for what changed; these tick the plan's lines too. New work during the day is a new `plan_add`. When the engineer's rules say to stop and ask (merge, deploy, send a message), stop and record it: `ticket_set` with `gate` (the question, ending in "?"; a standing rule or condition is not a gate). Never answer a gate yourself.
7. Reply with the RESUME block and the lines as `day` shows them, nothing else.
