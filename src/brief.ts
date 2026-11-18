import type { Ctx, Result } from "./commands.ts";
import { all, type DraftRow, type ItemRow, type SourceRow, type Ticket, type WaitRow } from "./db.ts";
import { itemLine } from "./items.ts";
import { cut, nowTs } from "./util.ts";

const MAX_ROWS = 40;
const MAX_LINE = 160;

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

  const draftLine = (d: DraftRow) => [d.ticket_id, d.label, d.channel ?? "-", firstLine(d.body)].join(" | ");
  const lines = [
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
    ...section("tracked", items.map(itemLine)),
  ];
  return {
    text: lines.join("\n"),
    json: { sources, tickets, drafts, pending, waits, items: items.slice(0, MAX_ROWS) },
  };
}
