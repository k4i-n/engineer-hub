import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Ctx, Result } from "./commands.ts";
import { all, getTicket, type ItemRow, one } from "./db.ts";
import { HubError, linkKind, linkSource, nowIso } from "./util.ts";

export const ITEM_KINDS = [
  "pr",
  "issue",
  "review_request",
  "thread",
  "message",
  "mail",
  "alert",
  "doc",
  "run",
  "other",
] as const;

export type ItemInput = {
  source: string;
  ref: string;
  kind: string;
  title: string | null;
  url: string | null;
  state: string | null;
  author: string | null;
  ticket_id: string | null;
  needs_me: boolean | null;
};

export type Upsert = "new" | "changed" | "unchanged";

export function itemByRef(db: DatabaseSync, ref: string): ItemRow | undefined {
  return one<ItemRow>(db, "SELECT * FROM item WHERE ref = ?", ref);
}

export function upsertItem(db: DatabaseSync, input: ItemInput, at: string): Upsert {
  const existing = itemByRef(db, input.ref);
  if (!existing) {
    db.prepare(
      `INSERT INTO item(source, ref, kind, title, url, state, author, ticket_id, needs_me, first_seen, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.source,
      input.ref,
      input.kind,
      input.title,
      input.url,
      input.state,
      input.author,
      input.ticket_id,
      input.needs_me ? 1 : 0,
      at,
      at,
    );
    return "new";
  }
  const next = {
    kind: input.kind,
    title: input.title ?? existing.title,
    url: input.url ?? existing.url,
    state: input.state ?? existing.state,
    author: input.author ?? existing.author,
    ticket_id: input.ticket_id ?? existing.ticket_id,
    needs_me: input.needs_me === null ? existing.needs_me : input.needs_me ? 1 : 0,
  };
  const fields = Object.keys(next) as (keyof typeof next)[];
  if (fields.every((f) => next[f] === existing[f])) return "unchanged";
  const values: SQLInputValue[] = fields.map((f) => next[f]);
  db.prepare(`UPDATE item SET ${fields.map((f) => `${f} = ?`).join(", ")}, changed_at = ? WHERE id = ?`).run(
    ...values,
    at,
    existing.id,
  );
  return "changed";
}

export function itemLine(i: ItemRow): string {
  return [
    `#${i.id} ${i.source}/${i.kind}`,
    i.needs_me ? "needs you" : null,
    i.title,
    i.state,
    i.ticket_id,
    i.url ?? i.ref,
    i.closed_at ? "closed" : null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" | ");
}

export type LinkOptions = { kind: string | null; title: string | null };

export function link(ctx: Ctx, id: string, url: string, options: LinkOptions): Result {
  if (options.kind !== null && !(ITEM_KINDS as readonly string[]).includes(options.kind)) {
    throw new HubError(`--kind must be one of ${ITEM_KINDS.join(", ")}, not ${options.kind}`);
  }
  getTicket(ctx.db, id);
  const existing = itemByRef(ctx.db, url);
  const source = existing?.source ?? linkSource(url, ctx.config.trackerHosts);
  const kind = options.kind ?? existing?.kind ?? linkKind(url, source);
  const at = nowIso(ctx.now);
  upsertItem(
    ctx.db,
    { source, ref: url, kind, title: options.title, url, state: null, author: null, ticket_id: id, needs_me: null },
    at,
  );
  ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(at, id);
  return { text: `${id} link ${source}/${kind} ${url}`, json: { ticket_id: id, url, source, kind } };
}

export type ItemsFilter = { needsMe: boolean; source: string | null; ticket: string | null; all: boolean };

export function items(ctx: Ctx, filter: ItemsFilter): Result {
  if (filter.ticket !== null) getTicket(ctx.db, filter.ticket);
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (!filter.all) where.push("closed_at IS NULL");
  if (filter.needsMe) where.push("needs_me = 1");
  if (filter.source !== null) {
    where.push("source = ?");
    params.push(filter.source);
  }
  if (filter.ticket !== null) {
    where.push("ticket_id = ?");
    params.push(filter.ticket);
  }
  const rows = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY needs_me DESC, changed_at DESC, id DESC`,
    ...params,
  );
  return { text: rows.map(itemLine).join("\n") || "no items", json: rows };
}
