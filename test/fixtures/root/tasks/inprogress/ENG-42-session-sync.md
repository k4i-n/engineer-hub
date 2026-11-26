# ENG-42 - Sync login sessions across devices

## State

```
Status: Schema drafted; migration next. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until refresh. Sessions move between devices and the old token stays valid until re
Repo: acme/web | Worktree: ~/wt/eng-42 | Branch: feat/session-sync
PRs: #101
Gate: waiting on design review
Order: P2
Next: write the migration for the sessions table
Owner: me | Updated: 2026-11-12
Linear: https://tracker.example.com/acme/issue/ENG-42
```

## Ticket body as filed

Users get logged out when they switch devices.

## Detail

Sessions are stored per device. The plan is a shared session table.

## Log

- 2026-11-12 14:2x: read the session middleware
  it keys sessions by device id
- 2026-11-12 15:00-16:3x: drafted the schema
- 2026-11-13: decided on a shared table

## Messages

<!-- drafts for humans to post -->

### Posted 2026-11-06

Posted in #web: the rollout starts Monday.

### D24 - ask design about the banner (context)

Can we show a banner when a session moves?

## Inventory

- session middleware
- token refresh job

<!-- linear-sync:start id=ENG-42 -->
**State:** In Review
**Priority:** High
**Assignee:** Sam Owner
**Created:** 2026-11-01 | **Updated:** 2026-11-12
**Link:** [ENG-42](https://tracker.example.com/acme/issue/ENG-42)
**Attachments:** https://github.com/acme/web/pull/101 https://docs.example.com/session-design
<!-- linear-sync:end -->
