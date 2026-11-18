---
name: hub-plan
description: Write the engineer's plan for today into the local hub record from what is open, waiting and new, instead of a markdown plan file. Use when asked for the plan for today, the morning plan, or what to work on next.
---

# hub-plan

1. Run the `hub-sync` skill first, unless a sync finished in the last 30 minutes (`hub sources`).
2. Read, in this order, and nothing else unless a ticket needs it:

   ```sh
   hub items --needs-me
   hub waits --due
   hub gates
   hub next
   hub day
   ```

3. Order the day: what blocks other people first (review requests, questions asked of the engineer, alerts), then pings that are due, then decisions waiting on the engineer, then ticket work by priority. Carry over yesterday's unfinished RESUME items.
4. Write the plan into hub, never into a file:

   ```sh
   hub day set <YYYY-MM-DD> --stdin <<'MD'
   # Plan <YYYY-MM-DD>

   ## RESUME
   <the first thing to do, one or two lines>

   ## Today
   - [ ] <ticket id>: <one action>
   MD
   ```

5. For each ticket worked today, keep its state in hub as the work goes: `hub set <id> next "<one action>"`, `hub step done <id> <n>` when a step finishes, `hub log <id> "<what changed>"`. When the engineer's rules say to stop and ask (merge, deploy, send a message), stop and record it: `hub set <id> gate "<the question>"`.
6. Reply with the RESUME block and the list, nothing else.
