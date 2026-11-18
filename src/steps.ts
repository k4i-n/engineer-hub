import type { DatabaseSync } from "node:sqlite";
import type { Ctx, Result } from "./commands.ts";
import { all, getTicket, one, type StepRow, transaction } from "./db.ts";
import { HubError, nowIso, nowTs } from "./util.ts";

const MAX_TITLE = 240;
const MAX_EVIDENCE = 2048;

export type Progress = { done: number; total: number; next: StepRow | null };

export function progress(db: DatabaseSync, id: string): Progress {
  const rows = all<StepRow>(db, "SELECT * FROM step WHERE ticket_id = ? ORDER BY n", id);
  return {
    done: rows.filter((s) => s.done_at !== null).length,
    total: rows.length,
    next: rows.find((s) => s.done_at === null) ?? null,
  };
}

export function stepLine(s: StepRow): string {
  return `${s.n} [${s.done_at === null ? " " : "x"}] ${s.title}${s.evidence ? ` | ${s.evidence}` : ""}`;
}

export function add(ctx: Ctx, id: string, title: string): Result {
  if (!title.trim()) throw new HubError("step title is empty");
  if (title.length > MAX_TITLE) throw new HubError(`step title is ${title.length} chars (max ${MAX_TITLE})`);
  getTicket(ctx.db, id);
  const n = (one<{ n: number | null }>(ctx.db, "SELECT max(n) AS n FROM step WHERE ticket_id = ?", id)?.n ?? 0) + 1;
  const at = nowIso(ctx.now);
  transaction(ctx.db, () => {
    ctx.db.prepare("INSERT INTO step(ticket_id, n, title, created_at) VALUES (?, ?, ?, ?)").run(id, n, title, at);
    ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(at, id);
  });
  return { text: `${id} step ${n} added`, json: { ticket_id: id, n, title } };
}

export function done(ctx: Ctx, id: string, n: string, evidence: string | null): Result {
  if (evidence !== null && evidence.length > MAX_EVIDENCE) {
    throw new HubError(`--evidence is ${evidence.length} chars (max ${MAX_EVIDENCE})`);
  }
  getTicket(ctx.db, id);
  const step = one<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? AND n = ?", id, Number(n));
  if (!step) throw new HubError(`no step ${n} on ${id} (hub steps ${id} lists them)`);
  if (step.done_at !== null) throw new HubError(`step ${n} on ${id} is already done`);
  const at = nowIso(ctx.now);
  transaction(ctx.db, () => {
    ctx.db.prepare("UPDATE step SET done_at = ?, evidence = ? WHERE id = ?").run(at, evidence, step.id);
    ctx.db
      .prepare(
        "INSERT INTO event(ticket_id, ts, kind, text, source, ref, created_at) VALUES (?, ?, 'step', ?, 'agent', ?, ?)",
      )
      .run(id, nowTs(ctx.now, ctx.config.timezone), `step ${step.n} done: ${step.title}`, evidence, at);
    ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(at, id);
  });
  const p = progress(ctx.db, id);
  return {
    text: `${id} step ${step.n} done (${p.done}/${p.total})${p.next ? `, next: ${p.next.n} ${p.next.title}` : ""}`,
    json: { ticket_id: id, n: step.n, done: p.done, total: p.total },
  };
}

export function steps(ctx: Ctx, id: string): Result {
  getTicket(ctx.db, id);
  const rows = all<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? ORDER BY n", id);
  return { text: rows.map(stepLine).join("\n") || "no steps", json: rows };
}
