import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Ctx, Result } from "./commands.ts";
import { all, getTicket, type ItemRow, one, transaction } from "./db.ts";
import { SOURCE_NAME } from "./sources.ts";
import { cut, HubError, linkKind, linkSource, nowIso, nowTs } from "./util.ts";

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

const MAX_TITLE = 240;
const MAX_LENGTH: Record<string, number> = { ref: 2048, url: 2048, state: 60, author: 120 };
const INPUT_KEYS = ["source", "ref", "kind", "title", "url", "state", "author", "ticket", "needs_me"];

export function itemByRef(db: DatabaseSync, ref: string): ItemRow | undefined {
  return one<ItemRow>(db, "SELECT * FROM item WHERE ref = ?", ref);
}

function findItem(db: DatabaseSync, key: string): ItemRow {
  const item = /^\d+$/.test(key)
    ? one<ItemRow>(db, "SELECT * FROM item WHERE id = ?", Number(key))
    : itemByRef(db, key);
  if (!item) throw new HubError(`no item ${key} (hub items --all lists them)`);
  return item;
}

function describe(i: { source: string; kind: string; title: string | null; ref: string }): string {
  return `${i.source}/${i.kind}: ${cut(i.title ?? i.ref, 120)}`;
}

function event(ctx: Ctx, ticketId: string, text: string, ref: string): void {
  ctx.db
    .prepare(
      "INSERT INTO event(ticket_id, ts, kind, text, source, ref, created_at) VALUES (?, ?, 'sync', ?, 'sync', ?, ?)",
    )
    .run(ticketId, nowTs(ctx.now, ctx.config.timezone), text, ref, nowIso(ctx.now));
  ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(nowIso(ctx.now), ticketId);
}

function matchTicket(ctx: Ctx, texts: (string | null)[]): string | null {
  const pattern = new RegExp(ctx.config.ticketIdPattern, "g");
  for (const text of texts) {
    for (const [id] of (text ?? "").matchAll(pattern)) {
      if (one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id)) return id;
    }
  }
  return null;
}

export function upsertItem(ctx: Ctx, input: ItemInput, withEvents: boolean): Upsert {
  const { db } = ctx;
  const at = nowIso(ctx.now);
  const existing = itemByRef(db, input.ref);
  const ref = input.url ?? input.ref;
  if (!existing) {
    const ticketId = input.ticket_id ?? matchTicket(ctx, [input.title, input.url, input.ref]);
    if (withEvents && ticketId !== null) event(ctx, ticketId, `new ${describe(input)}`, ref);
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
      ticketId,
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
    ticket_id:
      input.ticket_id ?? existing.ticket_id ?? matchTicket(ctx, [input.title, input.url, existing.title, existing.ref]),
    needs_me: input.needs_me === null ? existing.needs_me : input.needs_me ? 1 : 0,
  };
  const fields = Object.keys(next) as (keyof typeof next)[];
  if (fields.every((f) => next[f] === existing[f])) return "unchanged";
  const stateChanged = next.state !== existing.state;
  const reopen = stateChanged || (next.needs_me === 1 && existing.needs_me === 0);
  const closedAt = reopen ? null : existing.closed_at;
  const values: SQLInputValue[] = fields.map((f) => next[f]);
  db.prepare(
    `UPDATE item SET ${fields.map((f) => `${f} = ?`).join(", ")}, closed_at = ?, changed_at = ? WHERE id = ?`,
  ).run(...values, closedAt, at, existing.id);
  if (!withEvents || next.ticket_id === null) return "changed";
  const merged = { ...existing, ...next };
  if (next.ticket_id !== existing.ticket_id) event(ctx, next.ticket_id, `attached ${describe(merged)}`, ref);
  if (stateChanged) {
    event(ctx, next.ticket_id, `${describe(merged)}: ${existing.state ?? "-"} -> ${next.state ?? "-"}`, ref);
  }
  return "changed";
}

function text(line: number, key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HubError(`line ${line}: ${key} must be a string`);
  const max = MAX_LENGTH[key];
  if (max !== undefined && value.length > max) {
    throw new HubError(`line ${line}: ${key} is ${value.length} chars (max ${max})`);
  }
  return value;
}

export function parseItems(ctx: Ctx, input: string): ItemInput[] {
  const lines = input.split("\n");
  const parsed: ItemInput[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HubError(`line ${line}: not JSON`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HubError(`line ${line}: must be a JSON object`);
    }
    const o = value as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !INPUT_KEYS.includes(k));
    if (unknown !== undefined) throw new HubError(`line ${line}: unknown key ${unknown} (${INPUT_KEYS.join(", ")})`);
    const source = text(line, "source", o.source);
    if (source === null || !SOURCE_NAME.test(source)) {
      throw new HubError(`line ${line}: source must be a lowercase name such as github or slack`);
    }
    const kind = text(line, "kind", o.kind);
    if (kind === null || !(ITEM_KINDS as readonly string[]).includes(kind)) {
      throw new HubError(`line ${line}: kind must be one of ${ITEM_KINDS.join(", ")}`);
    }
    const url = text(line, "url", o.url);
    const ref = text(line, "ref", o.ref) ?? url;
    if (ref === null) throw new HubError(`line ${line}: give ref or url`);
    const ticket = text(line, "ticket", o.ticket);
    if (ticket !== null && !one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", ticket)) {
      throw new HubError(`line ${line}: no ticket ${ticket}`);
    }
    if (o.needs_me !== undefined && typeof o.needs_me !== "boolean") {
      throw new HubError(`line ${line}: needs_me must be true or false`);
    }
    const title = text(line, "title", o.title);
    parsed.push({
      source,
      ref,
      kind,
      title: title === null ? null : cut(title, MAX_TITLE),
      url,
      state: text(line, "state", o.state),
      author: text(line, "author", o.author),
      ticket_id: ticket,
      needs_me: o.needs_me === undefined ? null : o.needs_me,
    });
  }
  if (parsed.length === 0) throw new HubError("no items on stdin (one JSON object per line)");
  return parsed;
}

export function put(ctx: Ctx, input: string): Result {
  const parsed = parseItems(ctx, input);
  const counts: Record<Upsert, number> = { new: 0, changed: 0, unchanged: 0 };
  transaction(ctx.db, () => {
    for (const item of parsed) counts[upsertItem(ctx, item, true)]++;
  });
  return { text: `items: ${counts.new} new, ${counts.changed} changed, ${counts.unchanged} unchanged`, json: counts };
}

export function close(ctx: Ctx, keys: string[]): Result {
  if (keys.length === 0) throw new HubError("usage: hub item close <item>...");
  const found = keys.map((k) => findItem(ctx.db, k));
  const at = nowIso(ctx.now);
  transaction(ctx.db, () => {
    for (const i of found) {
      ctx.db.prepare("UPDATE item SET closed_at = coalesce(closed_at, ?) WHERE id = ?").run(at, i.id);
    }
  });
  return { text: `closed ${found.map((i) => `#${i.id}`).join(", ")}`, json: found.map((i) => i.id) };
}

export function attach(ctx: Ctx, key: string, ticketId: string): Result {
  getTicket(ctx.db, ticketId);
  const item = findItem(ctx.db, key);
  if (item.ticket_id === ticketId) return { text: `#${item.id} already on ${ticketId}`, json: item };
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE item SET ticket_id = ?, changed_at = ? WHERE id = ?")
      .run(ticketId, nowIso(ctx.now), item.id);
    event(ctx, ticketId, `attached ${describe(item)}`, item.url ?? item.ref);
  });
  return { text: `#${item.id} attached to ${ticketId}`, json: { id: item.id, ticket_id: ticketId } };
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
  upsertItem(
    ctx,
    { source, ref: url, kind, title: options.title, url, state: null, author: null, ticket_id: id, needs_me: null },
    false,
  );
  ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(nowIso(ctx.now), id);
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
