import type { DatabaseSync } from "node:sqlite";
import type { Ctx, Result } from "./commands.ts";
import { all, getTicket, one, type StepRow, transaction } from "./db.ts";
import { HubError, nowIso, nowTs } from "./util.ts";

const MAX_TITLE = 240;
const MAX_EVIDENCE = 2048;

export type Progress = { done: number; total: number; doing: StepRow[] };

export function isDoing(s: StepRow): boolean {
  return s.started_at !== null && s.done_at === null;
}

export function progress(db: DatabaseSync, id: string): Progress {
  const rows = all<StepRow>(db, "SELECT * FROM step WHERE ticket_id = ? ORDER BY n", id);
  return { done: rows.filter((s) => s.done_at !== null).length, total: rows.length, doing: rows.filter(isDoing) };
}

export function stepLine(s: StepRow): string {
  const box = s.done_at !== null ? "x" : isDoing(s) ? ">" : " ";
  return `${s.n} [${box}] ${s.title}${s.evidence ? ` | ${s.evidence}` : ""}`;
}

function stepEvent(ctx: Ctx, id: string, text: string): void {
  ctx.db
    .prepare("INSERT INTO event(ticket_id, ts, kind, text, source, created_at) VALUES (?, ?, 'step', ?, 'agent', ?)")
    .run(id, nowTs(ctx.now, ctx.config.timezone), text, nowIso(ctx.now));
}

function checkTitle(title: string): void {
  if (!title.trim()) throw new HubError("step title is empty");
  if (title.length > MAX_TITLE) throw new HubError(`step title is ${title.length} chars (max ${MAX_TITLE})`);
}

function getStep(ctx: Ctx, id: string, n: string): StepRow {
  getTicket(ctx.db, id);
  const step = one<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? AND n = ?", id, Number(n));
  if (!step) throw new HubError(`no step ${n} on ${id} (hub steps ${id} lists them)`);
  return step;
}

function shift(ctx: Ctx, id: string, from: number, by: number): void {
  ctx.db.prepare("UPDATE step SET n = -(n + ?) WHERE ticket_id = ? AND n >= ?").run(by, id, from);
  ctx.db.prepare("UPDATE step SET n = -n WHERE ticket_id = ? AND n < 0").run(id);
}

function touch(ctx: Ctx, id: string): void {
  ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(nowIso(ctx.now), id);
}

export function add(ctx: Ctx, id: string, title: string, place: number | null = null): Result {
  checkTitle(title);
  getTicket(ctx.db, id);
  const last = one<{ n: number | null }>(ctx.db, "SELECT max(n) AS n FROM step WHERE ticket_id = ?", id)?.n ?? 0;
  if (place !== null && !(Number.isInteger(place) && place >= 1)) throw new HubError("--at takes a step number from 1");
  const n = place === null ? last + 1 : Math.min(place, last + 1);
  transaction(ctx.db, () => {
    shift(ctx, id, n, 1);
    ctx.db
      .prepare("INSERT INTO step(ticket_id, n, title, created_at) VALUES (?, ?, ?, ?)")
      .run(id, n, title, nowIso(ctx.now));
    touch(ctx, id);
  });
  return { text: `${id} step ${n} added`, json: { ticket_id: id, n, title } };
}

export function edit(ctx: Ctx, id: string, n: string, title: string): Result {
  checkTitle(title);
  const step = getStep(ctx, id, n);
  transaction(ctx.db, () => {
    ctx.db.prepare("UPDATE step SET title = ? WHERE id = ?").run(title, step.id);
    touch(ctx, id);
  });
  return { text: `${id} step ${step.n} changed`, json: { ticket_id: id, n: step.n, title } };
}

export function start(ctx: Ctx, id: string, n: string): Result {
  const step = getStep(ctx, id, n);
  if (step.done_at !== null) throw new HubError(`step ${n} on ${id} is already done`);
  if (step.started_at !== null) throw new HubError(`step ${n} on ${id} is already started`);
  transaction(ctx.db, () => {
    ctx.db.prepare("UPDATE step SET started_at = ? WHERE id = ?").run(nowIso(ctx.now), step.id);
    stepEvent(ctx, id, `step ${step.n} started: ${step.title}`);
    touch(ctx, id);
  });
  return { text: `${id} step ${step.n} started`, json: { ticket_id: id, n: step.n } };
}

export function undo(ctx: Ctx, id: string, n: string): Result {
  const step = getStep(ctx, id, n);
  if (step.done_at === null && step.started_at === null) throw new HubError(`step ${n} on ${id} is not started`);
  const what = step.done_at === null ? "not started" : "not done";
  transaction(ctx.db, () => {
    ctx.db.prepare("UPDATE step SET done_at = NULL, started_at = NULL, evidence = NULL WHERE id = ?").run(step.id);
    stepEvent(ctx, id, `step ${step.n} ${what}: ${step.title}`);
    touch(ctx, id);
  });
  return { text: `${id} step ${step.n} ${what}`, json: { ticket_id: id, n: step.n } };
}

export function remove(ctx: Ctx, id: string, n: string): Result {
  const step = getStep(ctx, id, n);
  transaction(ctx.db, () => {
    ctx.db.prepare("DELETE FROM step WHERE id = ?").run(step.id);
    shift(ctx, id, step.n + 1, -1);
    touch(ctx, id);
  });
  return { text: `${id} step ${step.n} removed`, json: { ticket_id: id, n: step.n } };
}

export function done(ctx: Ctx, id: string, n: string, evidence: string | null): Result {
  if (evidence !== null && evidence.length > MAX_EVIDENCE) {
    throw new HubError(`--evidence is ${evidence.length} chars (max ${MAX_EVIDENCE})`);
  }
  const step = getStep(ctx, id, n);
  if (step.done_at !== null) throw new HubError(`step ${n} on ${id} is already done`);
  const at = nowIso(ctx.now);
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE step SET done_at = ?, started_at = coalesce(started_at, ?), evidence = ? WHERE id = ?")
      .run(at, at, evidence, step.id);
    ctx.db
      .prepare(
        "INSERT INTO event(ticket_id, ts, kind, text, source, ref, created_at) VALUES (?, ?, 'step', ?, 'agent', ?, ?)",
      )
      .run(id, nowTs(ctx.now, ctx.config.timezone), `step ${step.n} done: ${step.title}`, evidence, at);
    ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(at, id);
  });
  const p = progress(ctx.db, id);
  return {
    text: `${id} step ${step.n} done (${p.done}/${p.total})${p.doing.length > 0 ? `, still doing: ${p.doing.map((s) => s.n).join(", ")}` : ""}`,
    json: { ticket_id: id, n: step.n, done: p.done, total: p.total },
  };
}

export function steps(ctx: Ctx, id: string): Result {
  getTicket(ctx.db, id);
  const rows = all<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? ORDER BY n", id);
  return { text: rows.map(stepLine).join("\n") || "no steps", json: rows };
}
