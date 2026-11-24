import type { Ctx, Result } from "./commands.ts";
import {
  all,
  type DraftRow,
  draftOwner,
  getTicket,
  type ItemRow,
  one,
  type PlanLineRow,
  type StepRow,
  type Ticket,
  transaction,
  type WaitRow,
} from "./db.ts";
import { findItem } from "./items.ts";
import { githubRef, HubError, isDate, nowIso, nowTs, shiftDate, startOfDayIso, today } from "./util.ts";

const MAX_TEXT = 240;
const MAX_WHY = 240;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DONE_ITEM_STATES = ["merged", "closed", "done"];

export const REF_KINDS = ["step", "draft", "item", "wait", "gate", "ticket"] as const;
export type RefKind = (typeof REF_KINDS)[number];
export type Ref = { kind: RefKind; id: number | string };

export type RefState = {
  ref: Ref;
  name: string;
  state: string;
  doneAt: string | null;
  action: string;
  act: Record<string, string | number> | null;
  href: string | null;
};

export type LineState = {
  line: PlanLineRow;
  n: number;
  refs: RefState[];
  doneAt: string | null;
  dropped: boolean;
};

function isKind(value: string): value is RefKind {
  return (REF_KINDS as readonly string[]).includes(value);
}

function ticketOf(ctx: Ctx, id: string): Ticket | undefined {
  let current = id;
  for (let hop = 0; hop < 10; hop++) {
    const t = one<Ticket>(ctx.db, "SELECT * FROM ticket WHERE id = ?", current);
    if (t) return t;
    const moved = one<{ value: string }>(ctx.db, "SELECT value FROM meta WHERE key = ?", `moved-id:${current}`);
    if (moved === undefined) return undefined;
    current = moved.value;
  }
  return undefined;
}

function resolveOne(ctx: Ctx, input: string): Ref {
  const url = /^https?:\/\//.test(input);
  const colon = input.indexOf(":");
  const kind = url ? "item" : input.slice(0, colon);
  const value = url ? input : input.slice(colon + 1);
  if (colon < 1 && !url) throw new HubError(`ref ${input} needs a kind: ${REF_KINDS.map((k) => `${k}:`).join(", ")}`);
  if (!isKind(kind)) throw new HubError(`ref kind ${kind} is not one of ${REF_KINDS.join(", ")}`);
  if (value === "") throw new HubError(`ref ${input} names nothing after ${kind}:`);
  if (kind === "step") {
    const hash = value.lastIndexOf("#");
    const ticket = value.slice(0, hash);
    const n = Number(value.slice(hash + 1));
    if (hash < 1 || !Number.isInteger(n)) throw new HubError(`step ref is step:<ticket>#<n>, not step:${value}`);
    getTicket(ctx.db, ticket);
    const step = one<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? AND n = ?", ticket, n);
    if (!step) throw new HubError(`no step ${n} on ${ticket} (hub steps ${ticket} lists them)`);
    return { kind, id: step.id };
  }
  if (kind === "draft") {
    const draft = one<DraftRow>(
      ctx.db,
      "SELECT * FROM draft WHERE coalesce(ticket_id, item) || '/' || label = ? ORDER BY id LIMIT 1",
      value,
    );
    if (!draft) throw new HubError(`no draft ${value} (draft ref is draft:<ticket or item url>/<label>)`);
    return { kind, id: draft.id };
  }
  if (kind === "item") return { kind, id: findItem(ctx.db, value).id };
  if (kind === "wait") {
    const wait = /^\d+$/.test(value)
      ? one<WaitRow>(ctx.db, "SELECT * FROM wait WHERE id = ?", Number(value))
      : undefined;
    if (!wait) throw new HubError(`no wait ${value} (hub waits lists them)`);
    return { kind, id: wait.id };
  }
  return { kind, id: getTicket(ctx.db, value).id };
}

export function resolveRefs(ctx: Ctx, input: string | null): Ref[] {
  if (input === null) return [];
  const refs = input
    .split(/\s+/)
    .filter((r) => r !== "")
    .map((r) => resolveOne(ctx, r));
  return refs.filter((r, i) => refs.findIndex((o) => o.kind === r.kind && o.id === r.id) === i);
}

function clock(ctx: Ctx, iso: string, date: string): string {
  const ts = nowTs(new Date(iso), ctx.config.timezone);
  return ts.startsWith(date) ? ts.slice(11) : `${ts.slice(5, 10)} ${ts.slice(11)}`;
}

function before(at: string | null, until: string | null): string | null {
  return at !== null && (until === null || at < until) ? at : null;
}

function gone(ref: Ref): RefState {
  return { ref, name: `${ref.kind} ${ref.id}`, state: "gone", doneAt: null, action: "", act: null, href: null };
}

function stepState(ctx: Ctx, ref: Ref, until: string | null): RefState {
  const s = one<StepRow>(ctx.db, "SELECT * FROM step WHERE id = ?", ref.id);
  if (!s) return gone(ref);
  const doneAt = before(s.done_at, until);
  return {
    ref,
    name: `${s.ticket_id} step ${s.n}`,
    state: doneAt === null ? "open" : "done",
    doneAt,
    action: `step_done ${s.ticket_id} ${s.n}`,
    act: { act: "step-done", ticket: s.ticket_id, n: s.n },
    href: `/t/${encodeURIComponent(s.ticket_id)}`,
  };
}

function draftState(ctx: Ctx, ref: Ref, until: string | null): RefState {
  const d = one<DraftRow>(ctx.db, "SELECT * FROM draft WHERE id = ?", ref.id);
  if (!d) return gone(ref);
  const owner = draftOwner(d);
  const doneAt = d.status === "draft" ? null : before(d.posted_at ?? d.created_at, until);
  const state = doneAt !== null ? "sent" : d.match_ref !== null ? "sent?" : "not sent";
  return {
    ref,
    name: `draft ${d.label}`,
    state,
    doneAt,
    action: `posted ${owner} ${d.label}`,
    act: { act: "sent", ticket: owner, label: d.label },
    href: d.ticket_id === null ? null : `/t/${encodeURIComponent(d.ticket_id)}`,
  };
}

function itemDone(i: ItemRow): string | null {
  if (i.closed_at !== null) return i.closed_at;
  return DONE_ITEM_STATES.includes(i.state ?? "") ? i.changed_at : null;
}

function itemState(ctx: Ctx, ref: Ref, until: string | null): RefState {
  const i = one<ItemRow>(ctx.db, "SELECT * FROM item WHERE id = ?", ref.id);
  if (!i) return gone(ref);
  const doneAt = before(itemDone(i), until);
  const url = i.url ?? (/^https?:/.test(i.ref) ? i.ref : null);
  return {
    ref,
    name: githubRef(url) ?? `item ${i.id}`,
    state: doneAt === null ? (i.state ?? "open") : DONE_ITEM_STATES.includes(i.state ?? "") ? (i.state ?? "") : "done",
    doneAt,
    action: `item_close ${i.id}`,
    act: { act: "item-done", id: i.id },
    href: url,
  };
}

function waitState(ctx: Ctx, ref: Ref, until: string | null, date: string): RefState {
  const w = one<WaitRow>(ctx.db, "SELECT * FROM wait WHERE id = ?", ref.id);
  if (!w) return gone(ref);
  const doneAt = before(w.closed_at, until);
  const ping = w.ping_after === null ? "waiting" : `ping ${clock(ctx, w.ping_after, date)}`;
  return {
    ref,
    name: `wait ${w.who}`,
    state: doneAt === null ? ping : "answered",
    doneAt,
    action: `wait_close ${w.id}`,
    act: { act: "wait-close", id: w.id },
    href: w.url,
  };
}

function gateState(ctx: Ctx, ref: Ref, line: PlanLineRow, until: string | null): RefState {
  const t = ticketOf(ctx, String(ref.id));
  if (!t) return gone(ref);
  const decision = one<{ created_at: string; text: string }>(
    ctx.db,
    `SELECT created_at, text FROM event WHERE ticket_id = ? AND kind = 'decision' AND source = 'human'
       AND created_at >= ? AND (? IS NULL OR created_at < ?) ORDER BY created_at LIMIT 1`,
    t.id,
    line.created_at,
    until,
    until,
  );
  return {
    ref,
    name: `gate ${t.id}`,
    state: decision === undefined ? "open" : decision.text.startsWith("No") ? "no" : "yes",
    doneAt: decision?.created_at ?? null,
    action: `the engineer answers the gate on ${t.id} (dashboard, Decide)`,
    act: null,
    href: `/t/${encodeURIComponent(t.id)}`,
  };
}

function ticketState(ctx: Ctx, ref: Ref, until: string | null): RefState {
  const t = ticketOf(ctx, String(ref.id));
  if (!t) return gone(ref);
  const doneAt = t.dir === "done" ? before(t.updated_at, until) : null;
  return {
    ref,
    name: t.id,
    state: doneAt === null ? (t.dir ?? "unfiled") : "done",
    doneAt,
    action: `ticket_set ${t.id} dir done`,
    act: null,
    href: `/t/${encodeURIComponent(t.id)}`,
  };
}

function refState(ctx: Ctx, ref: Ref, line: PlanLineRow, until: string | null): RefState {
  if (ref.kind === "step") return stepState(ctx, ref, until);
  if (ref.kind === "draft") return draftState(ctx, ref, until);
  if (ref.kind === "item") return itemState(ctx, ref, until);
  if (ref.kind === "wait") return waitState(ctx, ref, until, line.date);
  if (ref.kind === "gate") return gateState(ctx, ref, line, until);
  return ticketState(ctx, ref, until);
}

export function refsOf(line: PlanLineRow): Ref[] {
  return JSON.parse(line.refs) as Ref[];
}

function endOf(ctx: Ctx, date: string): string | null {
  return date < today(ctx.now, ctx.config.timezone) ? startOfDayIso(shiftDate(date, 1), ctx.config.timezone) : null;
}

export function lineState(
  ctx: Ctx,
  line: PlanLineRow,
  n: number,
  until: string | null = endOf(ctx, line.date),
): LineState {
  const refs = refsOf(line).map((r) => refState(ctx, r, line, until));
  const times = refs.map((r) => r.doneAt);
  const doneAt =
    refs.length === 0
      ? before(line.done_at, until)
      : times.every((t) => t !== null)
        ? (times.toSorted().at(-1) ?? null)
        : null;
  return { line, n, refs, doneAt, dropped: line.dropped_at !== null && (until === null || line.dropped_at < until) };
}

function rows(ctx: Ctx, date: string): PlanLineRow[] {
  return all<PlanLineRow>(ctx.db, "SELECT * FROM plan_line WHERE date = ? ORDER BY pos, id", date);
}

export function lines(ctx: Ctx, date: string): LineState[] {
  return rows(ctx, date).map((l, i) => lineState(ctx, l, i + 1));
}

export function hasLines(ctx: Ctx, date: string): boolean {
  return one(ctx.db, "SELECT 1 FROM plan_line WHERE date = ? LIMIT 1", date) !== undefined;
}

function refNote(ctx: Ctx, r: RefState, date: string): string {
  return r.doneAt === null || r.state === "yes" || r.state === "no"
    ? `${r.name}: ${r.state}`
    : `${r.name}, ${r.state === "done" ? "" : `${r.state} `}${clock(ctx, r.doneAt, date)}`;
}

export function lineText(ctx: Ctx, s: LineState): string {
  const { line } = s;
  const head = `${s.n}. ${line.time === null ? "" : `${line.time} `}${line.text}`;
  const carried = line.carried_from === null ? "" : ` · carried from ${line.carried_from.slice(5)}`;
  if (s.dropped) return `- ~~${head}~~ (dropped: ${line.why ?? ""})${carried}`;
  const notes =
    s.refs.length > 0
      ? s.refs.map((r) => refNote(ctx, r, line.date))
      : s.doneAt === null
        ? []
        : [clock(ctx, s.doneAt, line.date)];
  return `- [${s.doneAt === null ? " " : "x"}] ${head}${notes.length === 0 ? "" : ` (${notes.join(" · ")})`}${carried}`;
}

export const TODAY = "Today";

export function withLines(body: string, md: string): string {
  if (md === "") return body;
  const list = body.split("\n");
  const at = list.findIndex((l) => l.trim() === `## ${TODAY}`);
  if (at === -1) return `${body.trimEnd()}\n\n## ${TODAY}\n${md}\n`.trimStart();
  return [...list.slice(0, at + 1), md, ...list.slice(at + 1)].join("\n");
}

export function todayMarkdown(ctx: Ctx, date: string): string {
  const list = lines(ctx, date);
  return list.length === 0 ? "" : list.map((s) => lineText(ctx, s)).join("\n");
}

function planDate(ctx: Ctx, date: string | null): string {
  if (date === null) return today(ctx.now, ctx.config.timezone);
  if (!isDate(date)) throw new HubError(`date must be YYYY-MM-DD, not ${date}`);
  return date;
}

function checkText(text: string): void {
  if (!text.trim()) throw new HubError("plan line text is empty");
  if (text.length > MAX_TEXT) throw new HubError(`plan line text is ${text.length} chars (max ${MAX_TEXT})`);
}

function checkTime(time: string | null): void {
  if (time !== null && time !== "" && !TIME.test(time)) throw new HubError(`time is HH:MM, not ${time}`);
}

function lineAt(ctx: Ctx, date: string, n: string | number): PlanLineRow {
  const list = rows(ctx, date);
  const line = list[Number(n) - 1];
  if (!Number.isInteger(Number(n)) || line === undefined) {
    throw new HubError(`no plan line ${n} on ${date} (hub day ${date} lists them)`);
  }
  return line;
}

function renumber(ctx: Ctx, list: PlanLineRow[]): void {
  const write = ctx.db.prepare("UPDATE plan_line SET pos = ? WHERE id = ?");
  list.forEach((l, i) => {
    write.run(i + 1, l.id);
  });
}

function warning(ctx: Ctx, text: string, refs: Ref[]): string {
  if (refs.length > 0) return "";
  const named = new RegExp(`\\b(?:${ctx.config.ticketIdPattern})\\b`).exec(text)?.[0];
  if (named === undefined) return "";
  return `\nwarning: the text names ${named} but the line has no ref, so it only ticks by hand; add --ref step:${named}#<n>, draft:${named}/<label>, item:<n> or ticket:${named}`;
}

function show(ctx: Ctx, line: PlanLineRow): LineState {
  const n = rows(ctx, line.date).findIndex((l) => l.id === line.id) + 1;
  return lineState(ctx, one<PlanLineRow>(ctx.db, "SELECT * FROM plan_line WHERE id = ?", line.id) ?? line, n);
}

function result(ctx: Ctx, line: PlanLineRow, verb: string, extra = ""): Result {
  const s = show(ctx, line);
  return {
    text: `${line.date} line ${s.n} ${verb}: ${lineText(ctx, s).replace(/^- /, "")}${extra}`,
    json: { ...s.line, n: s.n, refs: s.refs, done_at: s.doneAt, dropped: s.dropped },
  };
}

export type AddInput = {
  text: string;
  ref: string | null;
  time: string | null;
  at: number | null;
  date: string | null;
};

export function add(ctx: Ctx, input: AddInput): Result {
  checkText(input.text);
  checkTime(input.time);
  const date = planDate(ctx, input.date);
  const refs = resolveRefs(ctx, input.ref);
  if (input.at !== null && !(Number.isInteger(input.at) && input.at >= 1))
    throw new HubError("at takes a line number from 1");
  const at = nowIso(ctx.now);
  const line = transaction(ctx.db, () => {
    const list = rows(ctx, date);
    const place = input.at === null ? list.length : Math.min(input.at, list.length + 1) - 1;
    const { lastInsertRowid } = ctx.db
      .prepare(
        "INSERT INTO plan_line(date, pos, time, text, refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(date, place + 1, input.time || null, input.text, JSON.stringify(refs), at, at);
    const row = one<PlanLineRow>(ctx.db, "SELECT * FROM plan_line WHERE id = ?", lastInsertRowid) as PlanLineRow;
    list.splice(place, 0, row);
    renumber(ctx, list);
    return row;
  });
  return result(ctx, line, "added", warning(ctx, input.text, refs));
}

export type EditInput = { text: string | null; ref: string | null; time: string | null; date: string | null };

export function edit(ctx: Ctx, n: string, input: EditInput): Result {
  if (input.text === null && input.ref === null && input.time === null)
    throw new HubError("give text, ref or time to change");
  if (input.text !== null) checkText(input.text);
  checkTime(input.time);
  const line = lineAt(ctx, planDate(ctx, input.date), n);
  const refs = input.ref === null ? refsOf(line) : resolveRefs(ctx, input.ref);
  const text = input.text ?? line.text;
  const time = input.time === null ? line.time : input.time || null;
  const doneAt = refs.length === 0 ? line.done_at : null;
  ctx.db
    .prepare("UPDATE plan_line SET text = ?, refs = ?, time = ?, done_at = ?, updated_at = ? WHERE id = ?")
    .run(text, JSON.stringify(refs), time, doneAt, nowIso(ctx.now), line.id);
  return result(ctx, line, "changed", warning(ctx, text, refs));
}

export function move(ctx: Ctx, n: string, to: number, date: string | null): Result {
  if (!(Number.isInteger(to) && to >= 1)) throw new HubError("to takes a line number from 1");
  const day = planDate(ctx, date);
  const line = lineAt(ctx, day, n);
  transaction(ctx.db, () => {
    const list = rows(ctx, day).filter((l) => l.id !== line.id);
    list.splice(Math.min(to, list.length + 1) - 1, 0, line);
    renumber(ctx, list);
  });
  return result(ctx, line, "moved");
}

function refuseRefs(ctx: Ctx, line: PlanLineRow, verb: string): void {
  const refs = refsOf(line);
  if (refs.length === 0) return;
  const actions = refs.map((r) => refState(ctx, r, line, null).action).filter((a) => a !== "");
  throw new HubError(
    `plan line ${verb} works only on a line without refs; this one ticks from its refs: ${actions.join("; ")}`,
  );
}

export function done(ctx: Ctx, n: string, date: string | null): Result {
  const line = lineAt(ctx, planDate(ctx, date), n);
  refuseRefs(ctx, line, "done");
  if (line.done_at !== null) throw new HubError(`plan line ${n} is already done`);
  const at = nowIso(ctx.now);
  ctx.db.prepare("UPDATE plan_line SET done_at = ?, updated_at = ? WHERE id = ?").run(at, at, line.id);
  return result(ctx, line, "done");
}

export function undo(ctx: Ctx, n: string, date: string | null): Result {
  const line = lineAt(ctx, planDate(ctx, date), n);
  const at = nowIso(ctx.now);
  if (line.dropped_at !== null) {
    ctx.db.prepare("UPDATE plan_line SET dropped_at = NULL, why = NULL, updated_at = ? WHERE id = ?").run(at, line.id);
    return result(ctx, line, "back in the plan");
  }
  refuseRefs(ctx, line, "undo");
  if (line.done_at === null) throw new HubError(`plan line ${n} is not done`);
  ctx.db.prepare("UPDATE plan_line SET done_at = NULL, updated_at = ? WHERE id = ?").run(at, line.id);
  return result(ctx, line, "not done");
}

export function drop(ctx: Ctx, n: string, why: string, date: string | null): Result {
  if (!why.trim()) throw new HubError("drop needs a why: slipped, cancelled, moved to tomorrow...");
  if (why.length > MAX_WHY) throw new HubError(`why is ${why.length} chars (max ${MAX_WHY})`);
  const line = lineAt(ctx, planDate(ctx, date), n);
  if (line.dropped_at !== null) throw new HubError(`plan line ${n} is already dropped`);
  const at = nowIso(ctx.now);
  ctx.db.prepare("UPDATE plan_line SET dropped_at = ?, why = ?, updated_at = ? WHERE id = ?").run(at, why, at, line.id);
  return result(ctx, line, "dropped");
}

export function carry(ctx: Ctx, date: string): string[] {
  const from = one<{ date: string }>(
    ctx.db,
    `SELECT date FROM (SELECT date FROM day UNION SELECT date FROM plan_line) WHERE date < ? ORDER BY date DESC LIMIT 1`,
    date,
  )?.date;
  if (from === undefined) return [];
  const open = rows(ctx, from).filter((l) => {
    const s = lineState(ctx, l, 0, null);
    return !s.dropped && s.doneAt === null;
  });
  if (open.length === 0) return [];
  const start = rows(ctx, date).length;
  const at = nowIso(ctx.now);
  const insert = ctx.db.prepare(
    `INSERT INTO plan_line(date, pos, time, text, refs, carried_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  open.forEach((l, i) => {
    insert.run(date, start + i + 1, l.time, l.text, l.refs, l.carried_from ?? l.date, l.created_at, at);
  });
  return lines(ctx, date)
    .slice(start)
    .map((s) => lineText(ctx, s));
}
