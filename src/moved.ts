import type { Ctx, Result } from "./commands.ts";
import { all, type EventRow, type ItemRow, one, type WaitRow } from "./db.ts";
import { folds, KIND_NAME } from "./items.ts";
import { cut, HubError, nowIso } from "./util.ts";

const MAX_LINES = 8;
const MARK_DAYS = 7;
const AGENT = /^[A-Za-z0-9._:-]{1,120}$/;

type Mark = { at: string; event: number };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summary(ctx: Ctx): string {
  const now = nowIso(ctx.now);
  const needs = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE needs_me = 1 AND closed_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)",
    now,
  );
  const due = one<{ n: number }>(
    ctx.db,
    "SELECT count(*) AS n FROM wait WHERE closed_at IS NULL AND ping_after IS NOT NULL AND ping_after <= ?",
    now,
  )?.n;
  const kinds = new Map<string, number>();
  for (const i of needs) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  const parts = [...kinds].map(([k, n]) => plural(n, (KIND_NAME[k] ?? k).toLowerCase()));
  const lines = [
    needs.length === 0 ? null : `${needs.length} need you: ${parts.join(", ")}`,
    due ? `${plural(due, "ping")} due` : null,
  ].filter((l) => l !== null);
  return lines.length === 0 ? "" : `hub: ${lines.join("; ")}. The hub brief tool has the details.`;
}

function since(ctx: Ctx, mark: Mark): string[] {
  const now = nowIso(ctx.now);
  const items = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE needs_me = 1 AND closed_at IS NULL AND changed_at >= ?
       AND (snoozed_until IS NULL OR snoozed_until <= ?) ORDER BY changed_at`,
    mark.at,
    now,
  );
  const replied = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE state = 'replied' AND needs_me = 0 AND closed_at IS NULL AND changed_at >= ?
       ORDER BY changed_at`,
    mark.at,
  );
  const answered = all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE closed_at >= ? ORDER BY closed_at", mark.at);
  const due = all<WaitRow>(
    ctx.db,
    "SELECT * FROM wait WHERE closed_at IS NULL AND ping_after > ? AND ping_after <= ? ORDER BY ping_after",
    mark.at,
    now,
  );
  const human = all<EventRow>(ctx.db, "SELECT * FROM event WHERE source = 'human' AND id > ? ORDER BY id", mark.event);
  return [
    ...items.map((i) => {
      const count = folds(ctx.db, i)?.count;
      return `${KIND_NAME[i.kind] ?? i.kind}: ${cut(i.title ?? i.ref, 120)}${count ? ` ×${count}` : ""}${i.state ? ` (${i.state})` : ""}${i.ticket_id ? ` ${i.ticket_id}` : ""}`;
    }),
    ...replied.map((i) => `replied: ${cut(i.title ?? i.ref, 120)}`),
    ...answered.map((w) => `answered: ${w.who} on ${w.ticket_id}`),
    ...due.map((w) => `ping due: ${w.who} on ${w.ticket_id}`),
    ...human.map((e) => `you: ${e.text}${e.ticket_id ? ` ${e.ticket_id}` : ""}`),
  ];
}

export function moved(ctx: Ctx, agent: string, start: boolean): Result {
  if (!AGENT.test(agent)) throw new HubError("agent must be a session id: letters, digits, . _ : -");
  const key = `look:${agent}`;
  const raw = one<{ value: string }>(ctx.db, "SELECT value FROM meta WHERE key = ?", key)?.value;
  const top = one<{ id: number | null }>(ctx.db, "SELECT max(id) AS id FROM event")?.id ?? 0;
  const lines = start || raw === undefined ? [] : since(ctx, JSON.parse(raw) as Mark);
  const text = start
    ? summary(ctx)
    : lines.length === 0
      ? ""
      : [
          "hub, since your last prompt:",
          ...lines.slice(0, MAX_LINES).map((l) => `  ${l}`),
          ...(lines.length > MAX_LINES ? [`  (+${lines.length - MAX_LINES} more)`] : []),
        ].join("\n");
  const mark: Mark = { at: nowIso(ctx.now), event: top };
  const stale = new Date(ctx.now.getTime() - MARK_DAYS * 86_400_000).toISOString();
  ctx.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(mark));
  ctx.db.prepare("DELETE FROM meta WHERE key LIKE 'look:%' AND json_extract(value, '$.at') < ?").run(stale);
  return { text, json: { lines, mark } };
}
