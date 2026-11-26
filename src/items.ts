import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Ctx, Result } from "./commands.ts";
import { type Config, MAX_ASK } from "./config.ts";
import { all, type DraftRow, getTicket, type ItemRow, one, transaction } from "./db.ts";
import { SOURCE_NAME } from "./sources.ts";
import { cut, HubError, laterTime, linkKind, linkSource, nowIso, nowTs } from "./util.ts";

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
  avatar: string | null;
  ticket_id: string | null;
  needs_me: boolean | null;
  context: string | null;
  body: string | null;
  detail: string | null;
};

export type Upsert = "new" | "changed" | "unchanged";

const MAX_TITLE = 240;
const MAX_DETAIL = 240;
const ANSWERS = ["yes", "no"];
const MAX_LENGTH: Record<string, number> = {
  ref: 2048,
  url: 2048,
  state: 60,
  author: 120,
  avatar: 2048,
  context: 8000,
  body: 8000,
};
const INPUT_KEYS = [
  "source",
  "ref",
  "kind",
  "title",
  "url",
  "state",
  "author",
  "avatar",
  "ticket",
  "needs_me",
  "context",
  "body",
  "detail",
];

export function itemByRef(db: DatabaseSync, ref: string): ItemRow | undefined {
  return one<ItemRow>(db, "SELECT * FROM item WHERE ref = ?", ref);
}

export function findItem(db: DatabaseSync, key: string): ItemRow {
  const item = /^\d+$/.test(key)
    ? one<ItemRow>(db, "SELECT * FROM item WHERE id = ?", Number(key))
    : itemByRef(db, key);
  if (!item) throw new HubError(`no item ${key} (hub items --all lists them)`);
  return item;
}

export const KIND_NAME: Record<string, string> = {
  pr: "PR",
  issue: "Issue",
  review_request: "Review request",
  thread: "Thread",
  message: "Message",
  mail: "Mail",
  alert: "Alert",
  doc: "Doc",
  run: "Run",
  other: "Link",
};

function describe(i: { kind: string; title: string | null; ref: string }): string {
  return `${KIND_NAME[i.kind] ?? i.kind} ${cut(i.title ?? i.ref, 120)}`;
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
  const pattern = new RegExp(ctx.config.ticketIdPattern, "gi");
  for (const text of texts) {
    for (const [found] of (text ?? "").matchAll(pattern)) {
      const ticket = one<{ id: string }>(ctx.db, "SELECT id FROM ticket WHERE id = ? COLLATE NOCASE", found);
      if (ticket) return ticket.id;
    }
  }
  return null;
}

const REPO_KINDS = ["review_request", "pr"];

function repoOf(i: { source: string; kind: string; url: string | null; ref: string }): string | null {
  if (i.source !== "github" || !REPO_KINDS.includes(i.kind)) return null;
  return /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(i.url ?? i.ref)?.[1] ?? null;
}

const QUERY_KEY: Record<string, "githubReviewQuery" | "githubPrQuery"> = {
  review_request: "githubReviewQuery",
  pr: "githubPrQuery",
};

function excludedRepos(query: string): string[] {
  return [...query.matchAll(/(?:^|\s)-repo:(\S+)/g)].map((m) => (m[1] ?? "").toLowerCase());
}

function repoExcluded(config: Config, i: { source: string; kind: string; url: string | null; ref: string }): boolean {
  const repo = repoOf(i);
  const key = QUERY_KEY[i.kind];
  return repo !== null && key !== undefined && excludedRepos(config[key]).includes(repo.toLowerCase());
}

export function applyExcludedRepos(ctx: Ctx): void {
  const at = nowIso(ctx.now);
  const github = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE source = 'github' AND coalesce(ignored, 'repo') = 'repo'",
  );
  transaction(ctx.db, () => {
    for (const i of github) {
      const excluded = repoExcluded(ctx.config, i);
      if (excluded && i.ignored === null)
        ctx.db
          .prepare("UPDATE item SET ignored = 'repo', closed_at = coalesce(closed_at, ?) WHERE id = ?")
          .run(at, i.id);
      if (!excluded && i.ignored === "repo")
        ctx.db
          .prepare(
            `UPDATE item SET ignored = NULL, snoozed_until = NULL,
               closed_at = CASE WHEN coalesce(state, '') IN ('done', 'merged', 'closed') THEN closed_at END WHERE id = ?`,
          )
          .run(i.id);
    }
  });
}

const PR_TITLE = /^Title:\s*(.+)$/i;

export function prBodyTitle(body: string): string | null {
  return PR_TITLE.exec(body.split("\n", 1)[0]?.trim() ?? "")?.[1]?.trim() ?? null;
}

function postPrDraft(ctx: Ctx, ref: string): void {
  const item = itemByRef(ctx.db, ref);
  if (item === undefined || item.kind !== "pr" || item.ticket_id === null || item.title === null) return;
  const title = item.title.trim();
  const url = item.url ?? item.ref;
  const drafts = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE ticket_id = ? AND status = 'draft' AND match_ref IS NULL",
    item.ticket_id,
  ).filter((d) => prBodyTitle(d.body) === title);
  const at = nowIso(ctx.now);
  const [only] = drafts;
  if (only !== undefined && drafts.length === 1) {
    ctx.db
      .prepare(
        "UPDATE draft SET status = 'posted', posted_at = ?, sent_text = ?, sent_ref = ?, updated_at = ? WHERE id = ?",
      )
      .run(nowTs(ctx.now, ctx.config.timezone), item.body, url, at, only.id);
    return;
  }
  const ask = ctx.db.prepare("UPDATE draft SET match_text = ?, match_ref = ?, updated_at = ? WHERE id = ?");
  for (const d of drafts) ask.run(item.body ?? title, url, at, d.id);
}

export function upsertItem(ctx: Ctx, input: ItemInput, withEvents: boolean): Upsert {
  const result = writeItem(ctx, input, withEvents);
  if (result !== "unchanged") postPrDraft(ctx, input.ref);
  return result;
}

function writeItem(ctx: Ctx, input: ItemInput, withEvents: boolean): Upsert {
  const { db } = ctx;
  const at = nowIso(ctx.now);
  const existing = itemByRef(db, input.ref);
  const ref = input.url ?? input.ref;
  if (!existing) {
    const ignored = repoExcluded(ctx.config, input) ? "repo" : null;
    const ticketId = input.ticket_id ?? matchTicket(ctx, [input.title, input.url, input.ref, input.context]);
    const ask = input.kind === "review_request" && ignored === null ? ctx.config.reviewAsk.trim() || null : null;
    if (withEvents && ticketId !== null && ignored === null) event(ctx, ticketId, `New ${describe(input)}`, ref);
    db.prepare(
      `INSERT INTO item(source, ref, kind, title, url, state, author, avatar, ticket_id, needs_me, first_seen, changed_at, closed_at, ignored, body, detail, ask)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.source,
      input.ref,
      input.kind,
      input.title,
      input.url,
      input.state,
      input.author,
      input.avatar,
      ticketId,
      input.needs_me ? 1 : 0,
      at,
      at,
      ignored === null ? null : at,
      ignored,
      input.body,
      input.detail,
      ask,
    );
    return "new";
  }
  const next = {
    kind: input.kind,
    title: input.title ?? existing.title,
    url: input.url ?? existing.url,
    state: input.state ?? existing.state,
    author: input.author ?? existing.author,
    avatar: input.avatar ?? existing.avatar,
    body: input.body ?? existing.body,
    detail: input.detail ?? existing.detail,
    ticket_id:
      input.ticket_id ??
      existing.ticket_id ??
      (existing.detached
        ? null
        : matchTicket(ctx, [input.title, input.url, existing.title, existing.ref, input.context])),
    detached: input.ticket_id === null ? existing.detached : 0,
    needs_me: input.needs_me === null ? existing.needs_me : input.needs_me ? 1 : 0,
  };
  const fields = Object.keys(next) as (keyof typeof next)[];
  if (fields.every((f) => next[f] === existing[f])) return "unchanged";
  const stateChanged = next.state !== existing.state;
  const ignored = existing.ignored ?? (repoExcluded(ctx.config, { ...existing, ...next }) ? "repo" : null);
  const reopen = ignored === null && (stateChanged || (next.needs_me === 1 && existing.needs_me === 0));
  const closedAt = reopen ? null : ignored === null ? existing.closed_at : (existing.closed_at ?? at);
  const snoozedUntil = reopen ? null : existing.snoozed_until;
  const askAgain = reopen && next.kind === "review_request";
  const ask = askAgain ? ctx.config.reviewAsk.trim() || null : existing.ask;
  const askAnswer = askAgain ? null : existing.ask_answer;
  const askAt = askAgain ? null : existing.ask_at;
  const values: SQLInputValue[] = fields.map((f) => next[f]);
  db.prepare(
    `UPDATE item SET ${fields.map((f) => `${f} = ?`).join(", ")}, closed_at = ?, snoozed_until = ?, ignored = ?, changed_at = ?,
       ask = ?, ask_answer = ?, ask_at = ?
     WHERE id = ?`,
  ).run(...values, closedAt, snoozedUntil, ignored, at, ask, askAnswer, askAt, existing.id);
  if (!withEvents || next.ticket_id === null || ignored !== null) return "changed";
  const merged = { ...existing, ...next };
  if (next.ticket_id !== existing.ticket_id) event(ctx, next.ticket_id, `Attached ${describe(merged)}`, ref);
  if (stateChanged) {
    const change = existing.state === null ? `${next.state}` : `${existing.state} → ${next.state ?? "-"}`;
    event(ctx, next.ticket_id, `${describe(merged)}: ${change}`, ref);
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

function avatarUrl(line: number, value: unknown): string | null {
  const url = text(line, "avatar", value);
  if (url !== null && !url.startsWith("https://")) throw new HubError(`line ${line}: avatar must be an https URL`);
  return url;
}

function detailText(line: number, value: unknown): string | null {
  const detail = text(line, "detail", value);
  return detail === null ? null : cut(detail, MAX_DETAIL);
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
      avatar: avatarUrl(line, o.avatar),
      ticket_id: ticket,
      needs_me: o.needs_me === undefined ? null : o.needs_me,
      context: text(line, "context", o.context),
      body: text(line, "body", o.body),
      detail: detailText(line, o.detail),
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

export function snooze(ctx: Ctx, key: string, duration: string): Result {
  const item = findItem(ctx.db, key);
  const until = laterTime(ctx.now, duration, ctx.config.timezone, ctx.config.laterHour, "--for");
  ctx.db.prepare("UPDATE item SET snoozed_until = ? WHERE id = ?").run(until, item.id);
  return {
    text: `#${item.id} snoozed until ${nowTs(new Date(until), ctx.config.timezone)}`,
    json: { id: item.id, snoozed_until: until },
  };
}

export function reopen(ctx: Ctx, key: string): Result {
  const item = findItem(ctx.db, key);
  ctx.db.prepare("UPDATE item SET closed_at = NULL, snoozed_until = NULL WHERE id = ?").run(item.id);
  return { text: `#${item.id} reopened`, json: { id: item.id } };
}

export function ignore(ctx: Ctx, key: string): Result {
  const item = findItem(ctx.db, key);
  ctx.db
    .prepare("UPDATE item SET ignored = 'item', closed_at = coalesce(closed_at, ?) WHERE id = ?")
    .run(nowIso(ctx.now), item.id);
  return { text: `#${item.id} ignored`, json: { id: item.id } };
}

export function unignore(ctx: Ctx, key: string): Result {
  const item = findItem(ctx.db, key);
  if (item.ignored === null) throw new HubError(`#${item.id} is not ignored`);
  if (item.ignored === "repo")
    throw new HubError(`#${item.id} is left out by -repo: in ${QUERY_KEY[item.kind] ?? "its search"}`);
  ctx.db.prepare("UPDATE item SET ignored = NULL, closed_at = NULL, snoozed_until = NULL WHERE id = ?").run(item.id);
  return { text: `#${item.id} shown again`, json: { id: item.id } };
}

export function ask(ctx: Ctx, key: string, question: string): Result {
  const item = findItem(ctx.db, key);
  const text = question.trim();
  if (text.includes("\n") || text.length > MAX_ASK)
    throw new HubError(`a question is one line of at most ${MAX_ASK} chars`);
  ctx.db.prepare("UPDATE item SET ask = ?, ask_answer = NULL, ask_at = NULL WHERE id = ?").run(text || null, item.id);
  return {
    text: text === "" ? `#${item.id} has no question` : `#${item.id} asks: ${text}`,
    json: { id: item.id, ask: text || null },
  };
}

export function answer(ctx: Ctx, key: string, given: string): Result {
  if (!ANSWERS.includes(given)) throw new HubError(`answer must be yes or no, not ${given}`);
  const item = findItem(ctx.db, key);
  if (item.ask === null) throw new HubError(`#${item.id} has no question`);
  const at = nowIso(ctx.now);
  const closes = given === "no" && item.kind === "review_request" && item.ask === ctx.config.reviewAsk.trim();
  ctx.db
    .prepare(
      "UPDATE item SET ask_answer = ?, ask_at = ?, closed_at = CASE WHEN ? THEN coalesce(closed_at, ?) ELSE closed_at END WHERE id = ?",
    )
    .run(given, at, closes ? 1 : 0, at, item.id);
  return { text: `#${item.id} ${item.ask} ${given}`, json: { id: item.id, ask: item.ask, answer: given } };
}

export function unanswer(ctx: Ctx, key: string): Result {
  const item = findItem(ctx.db, key);
  if (item.ask_answer === null) throw new HubError(`#${item.id} has no answer`);
  ctx.db
    .prepare(
      "UPDATE item SET ask_answer = NULL, ask_at = NULL, closed_at = CASE WHEN closed_at = ask_at THEN NULL ELSE closed_at END WHERE id = ?",
    )
    .run(item.id);
  return { text: `#${item.id} asks again: ${item.ask}`, json: { id: item.id, ask: item.ask, answer: null } };
}

export function attach(ctx: Ctx, key: string, ticketId: string): Result {
  getTicket(ctx.db, ticketId);
  const item = findItem(ctx.db, key);
  if (item.ticket_id === ticketId) return { text: `#${item.id} already on ${ticketId}`, json: item };
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE item SET ticket_id = ?, detached = 0, changed_at = ? WHERE id = ?")
      .run(ticketId, nowIso(ctx.now), item.id);
    event(ctx, ticketId, `Attached ${describe(item)}`, item.url ?? item.ref);
    postPrDraft(ctx, item.ref);
  });
  return { text: `#${item.id} attached to ${ticketId}`, json: { id: item.id, ticket_id: ticketId } };
}

export function detach(ctx: Ctx, key: string): Result {
  const item = findItem(ctx.db, key);
  const from = item.ticket_id;
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE item SET ticket_id = NULL, detached = 1, changed_at = ? WHERE id = ?")
      .run(nowIso(ctx.now), item.id);
    if (from !== null) event(ctx, from, `Detached ${describe(item)}`, item.url ?? item.ref);
  });
  return {
    text: from === null ? `#${item.id} stays on no ticket` : `#${item.id} detached from ${from}`,
    json: { id: item.id, ticket_id: null },
  };
}

export function itemLine(i: ItemRow): string {
  return [
    `#${i.id} ${i.source}/${i.kind}`,
    i.needs_me ? "needs you" : null,
    i.title,
    i.state,
    i.ticket_id,
    i.url ?? i.ref,
    i.ask === null ? null : `ask: ${i.ask} ${i.ask_answer ?? "(no answer yet)"}`,
    i.ignored ? "ignored" : i.closed_at ? "closed" : null,
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
    {
      source,
      ref: url,
      kind,
      title: options.title,
      url,
      state: null,
      author: null,
      avatar: null,
      ticket_id: id,
      needs_me: null,
      context: null,
      body: null,
      detail: null,
    },
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
  if (!filter.all) {
    where.push("closed_at IS NULL", "(snoozed_until IS NULL OR snoozed_until <= ?)");
    params.push(nowIso(ctx.now));
  }
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
