---
name: hub-plan
description: Write the engineer's plan for today into the local hub record from what is open, waiting and new, instead of a markdown plan file. Use when asked for the plan for today, the morning plan, or what to work on next.
---

# hub-plan

The hub MCP tools (`mcp__plugin_engineer-hub_hub__*`) are named below by their short names.

1. Run the `hub-sync` skill first, unless `sources` shows a sync in the last 30 minutes.
2. Read, in this order, and nothing else unless a ticket needs it: `items` with `needs_me: true`, `waits` with `due: true`, `gates`, `next`, `day`.
3. Order the day: what blocks other people first (review requests, questions asked of the engineer, alerts), then pings that are due, then decisions waiting on the engineer, then ticket work by priority. Carry over yesterday's unfinished RESUME items.
4. Write the plan into hub, never into a file: `day_set` with `date` and `body`. If today already has a plan, read it with `day` and `full: true`, merge into it, and pass its `rev`; when `day_set` says the plan changed, read and merge again:

   ```markdown
   # Plan <YYYY-MM-DD>

   ## RESUME
   <the first thing to do, one or two lines>

   ## Today
   - [ ] <ticket id>: <one action>
   ```

5. For each ticket worked today, keep its state in hub as the work goes: `ticket_set` with `next` (one action), `step_done` when a step finishes, `log` for what changed. When the engineer's rules say to stop and ask (merge, deploy, send a message), stop and record it: `ticket_set` with `gate` (the question). Never answer a gate yourself.
6. Reply with the RESUME block and the list, nothing else.
