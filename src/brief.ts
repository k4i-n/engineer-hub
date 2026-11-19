import type { Ctx, Result } from "./commands.ts";
import {
  all,
  type DraftRow,
  type EventRow,
  type ItemRow,
  one,
  type SourceRow,
  type Ticket,
  type WaitRow,
} from "./db.ts";
import { itemLine } from "./items.ts";
import { cut, nowIso, nowTs } from "./util.ts";

const MAX_ROWS = 40;
const MAX_LINE = 160;
const FIRST_LOOK_MS = 86_400_000;

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [`${title}: none`];
  const shown = lines.slice(0, MAX_ROWS).map((l) => `  ${cut(l, MAX_LINE)}`);
  const more = lines.length > MAX_ROWS ? [`  (+${lines.length - MAX_ROWS} more)`] : [];
  return [`${title}:`, ...shown, ...more];
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "") ?? "";
}

export function brief(ctx: Ctx): Result {
  const shown = (iso: string) => nowTs(new Date(iso), ctx.config.timezone);
  const dirs = ctx.config.openDirs;
  const sources = all<SourceRow>(ctx.db, "SELECT * FROM source ORDER BY name");
  const tickets = all<Pick<Ticket, "id" | "title">>(
    ctx.db,
    `SELECT id, title FROM ticket WHERE dir IN (${dirs.map(() => "?").join(", ")}) ORDER BY id`,
    ...dirs,
  );
  const drafts = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE status = 'draft' ORDER BY ticket_id, label");
  const pending = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE status != 'draft' AND sent_text IS NULL ORDER BY ticket_id, label",
  );
  const waits = all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE closed_at IS NULL ORDER BY asked_at, id");
  const items = all<ItemRow>(ctx.db, "SELECT * FROM item WHERE closed_at IS NULL ORDER BY changed_at DESC, id DESC");
  const meta = (key: string) => one<{ value: string }>(ctx.db, "SELECT value FROM meta WHERE key = ?", key)?.value;
  const lastLook = meta("brief_at") ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS).toISOString();
  const lastEvent = meta("brief_event");
  const fromYou =
    lastEvent === undefined
      ? all<EventRow>(ctx.db, "SELECT * FROM event WHERE source = 'human' AND created_at > ? ORDER BY id", lastLook)
      : all<EventRow>(ctx.db, "SELECT * FROM event WHERE source = 'human' AND id > ? ORDER BY id", Number(lastEvent));
  const top = one<{ id: number | null }>(ctx.db, "SELECT max(id) AS id FROM event")?.id ?? 0;
  const mark = ctx.db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  mark.run("brief_at", nowIso(ctx.now));
  mark.run("brief_event", String(top));

  const scripts = all<{ name: string }>(ctx.db, "SELECT name FROM script_source ORDER BY name").map((r) => r.name);
  const fetched = [...Object.keys(ctx.config.fetch).filter((k) => ctx.config.fetch[k] === true), ...scripts];
  const toJudge = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE state = 'sent' AND closed_at IS NULL ORDER BY first_seen, id",
  );
  const draftLine = (d: DraftRow) =>
    [
      d.ticket_id,
      d.label,
      d.channel ?? "-",
      ...(d.send_at ? [`send ${shown(d.send_at)}`] : []),
      firstLine(d.body),
    ].join(" | ");
  const lines = [
    `hub fetches itself, do not read: ${fetched.join(", ") || "none"}`,
    ...section(
      "sources",
      sources.map((s) => `${s.name} | since ${shown(s.last_sync)} | cursor ${s.cursor ?? "-"}`),
    ),
    ...section(
      "tickets",
      tickets.map((t) => `${t.id} ${t.title ?? ""}`),
    ),
    ...section("drafts not sent", drafts.map(draftLine)),
    ...section(
      "sent, wording pending",
      pending.map((d) => `${draftLine(d)} | posted ${d.posted_at ?? "-"}${d.match_ref ? " | match proposed" : ""}`),
    ),
    ...section(
      "waits",
      waits.map((w) => `#${w.id} ${w.ticket_id} | ${w.who} | ${w.url} | asked ${shown(w.asked_at)}`),
    ),
    ...section(
      "to judge, the user's sent messages",
      toJudge.map((i) => `#${i.id} | ${i.title ?? ""} | ${i.url ?? i.ref}`),
    ),
    ...section("tracked", items.filter((i) => i.state !== "sent").map(itemLine)),
    ...section(
      `from you since ${shown(lastLook)}`,
      fromYou.map((e) => `${e.ts} ${e.ticket_id ?? "-"} ${e.text}`),
    ),
  ];
  return {
    text: lines.join("\n"),
    json: {
      fetched,
      to_judge: toJudge,
      sources,
      tickets,
      drafts,
      pending,
      waits,
      items: items.slice(0, MAX_ROWS),
      from_you: fromYou,
      since: lastLook,
    },
  };
}
