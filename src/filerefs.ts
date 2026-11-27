import { existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Ctx, event, type Result } from "./commands.ts";
import { all } from "./db.ts";
import { addFile, listFiles } from "./files.ts";
import { HubError, nowIso } from "./util.ts";

const BLOCK = /^Plan files \(source of truth stays in [^)]*\):?\s*$/;
const ENTRY = /^\s*-\s+`([^`]+)`\s*$/;

type NoteHit = { id: number; ticket_id: string; title: string; body: string };
type Ref = { path: string; source: string };
type Parsed = { note: NoteHit; refs: Ref[]; start: number; end: number };
type Move = { ticket: string; path: string; source: string; dest: string; done: boolean };
type NoteChange = { note: NoteHit; body: string | null };

export type RefPlan = {
  moves: Move[];
  notes: NoteChange[];
  missing: { ticket: string; path: string }[];
  shared: { path: string; owner: string; others: string[] }[];
  clashes: { ticket: string; path: string; dest: string }[];
  orphans: { ticket: string; title: string }[];
};

function parse(note: NoteHit, root: string): Parsed | null {
  const lines = note.body.split("\n");
  const start = lines.findIndex((l) => BLOCK.test(l));
  if (start === -1) return null;
  const refs: Ref[] = [];
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = ENTRY.exec(line);
    if (m === null && line.trim() !== "") break;
    if (m === null) continue;
    const path = (m[1] ?? "").replace(/\/+$/, "");
    const source = resolve(root, path);
    if (!source.startsWith(root + sep)) throw new HubError(`${path} on ${note.ticket_id} is outside ${root}`);
    refs.push({ path, source });
    end = i;
  }
  return { note, refs, start, end };
}

function without(body: string, start: number, end: number, insert: string[]): string | null {
  const lines = body.split("\n");
  const kept = [...lines.slice(0, start), ...insert, ...lines.slice(end + 1)];
  const text = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? null : text;
}

export function planRefs(ctx: Ctx, from: string): RefPlan {
  const root = resolve(from);
  if (!existsSync(root)) throw new HubError(`no folder ${root}`);
  const tickets = new Set(all<{ id: string }>(ctx.db, "SELECT id FROM ticket").map((t) => t.id));
  const hits = all<NoteHit>(
    ctx.db,
    "SELECT id, ticket_id, title, body FROM note WHERE body LIKE '%source of truth stays in%' ORDER BY id",
  );
  const plan: RefPlan = { moves: [], notes: [], missing: [], shared: [], clashes: [], orphans: [] };
  const owners = new Map<string, Move>();
  const taken = new Map<string, Set<string>>();
  const destOf = (ticket: string, source: string): string | null => {
    const used = taken.get(ticket) ?? new Set(listFiles(ctx.files, ticket).map((f) => f.path));
    taken.set(ticket, used);
    const name = basename(source);
    for (const dest of [name, `${basename(dirname(source))}/${name}`]) {
      if ([...used].some((u) => u === dest || u.startsWith(`${dest}/`) || dest.startsWith(`${u}/`))) continue;
      used.add(dest);
      return dest;
    }
    return null;
  };
  for (const parsed of hits.flatMap((n) => parse(n, root) ?? [])) {
    const { note, refs } = parsed;
    if (!tickets.has(note.ticket_id)) {
      plan.orphans.push({ ticket: note.ticket_id, title: note.title });
      continue;
    }
    const see: string[] = [];
    for (const ref of refs) {
      const owner = owners.get(ref.source);
      if (owner !== undefined) {
        see.push(`see ${owner.ticket}/files/${owner.dest}`);
        const entry = plan.shared.find((s) => s.path === ref.path);
        if (entry === undefined) plan.shared.push({ path: ref.path, owner: owner.ticket, others: [note.ticket_id] });
        else entry.others.push(note.ticket_id);
        continue;
      }
      const done = !existsSync(ref.source);
      const dest = done ? basename(ref.source) : destOf(note.ticket_id, ref.source);
      if (done && !existsSync(join(ctx.files, note.ticket_id, dest ?? ""))) {
        plan.missing.push({ ticket: note.ticket_id, path: ref.path });
        continue;
      }
      if (dest === null) {
        plan.clashes.push({ ticket: note.ticket_id, path: ref.path, dest: basename(ref.source) });
        continue;
      }
      const move = { ticket: note.ticket_id, path: ref.path, source: ref.source, dest, done };
      owners.set(ref.source, move);
      plan.moves.push(move);
    }
    plan.notes.push({ note, body: without(note.body, parsed.start, parsed.end, see) });
  }
  return plan;
}

export function applyRefs(ctx: Ctx, plan: RefPlan): void {
  if (plan.missing.length > 0 || plan.clashes.length > 0) {
    throw new HubError("fix the missing paths and name clashes the dry run lists, then apply again");
  }
  for (const m of plan.moves.filter((m) => !m.done)) {
    addFile(ctx.files, m.ticket, m.source, m.dest, true);
    event(ctx, m.ticket, `file added: ${m.dest} (moved from ${m.path})`);
  }
  const at = nowIso(ctx.now);
  for (const { note, body } of plan.notes) {
    if (body === null) ctx.db.prepare("DELETE FROM note WHERE id = ?").run(note.id);
    else ctx.db.prepare("UPDATE note SET body = ?, updated_at = ? WHERE id = ?").run(body, at, note.id);
  }
}

function mentions(ctx: Ctx): string[] {
  return all<{ ticket_id: string; title: string }>(
    ctx.db,
    "SELECT ticket_id, title FROM note WHERE body LIKE '%.claude/plan%' ORDER BY ticket_id, title",
  ).map((n) => `${n.ticket_id} ${n.title}`);
}

export function importRefs(ctx: Ctx, from: string, apply: boolean): Result {
  const plan = planRefs(ctx, from);
  if (apply) applyRefs(ctx, plan);
  const removed = plan.notes.filter((n) => n.body === null).length;
  const lines = [
    ...plan.moves.map((m) => `${m.path} -> ${m.ticket}/${m.dest}${m.done ? " (already there)" : ""}`),
    ...plan.shared.map(
      (s) => `shared: ${s.path} goes to ${s.owner}; ${s.others.join(", ")} get "see ${s.owner}/files/…"`,
    ),
    ...plan.missing.map((m) => `missing on disk: ${m.path} (${m.ticket})`),
    ...plan.clashes.map((c) => `name clash: ${c.path} on ${c.ticket} (${c.dest} and its folder name are taken)`),
    ...plan.orphans.map((o) => `no ticket: ${o.ticket} ${o.title} (left alone)`),
    `${plan.moves.length} paths into ${new Set(plan.moves.map((m) => m.ticket)).size} tickets; ${removed} notes removed, ${plan.notes.length - removed} edited`,
  ];
  if (!apply) lines.push("dry run: --apply moves the files and edits the notes");
  const left = apply ? mentions(ctx) : [];
  if (left.length > 0) lines.push(`notes still naming .claude/plan: ${left.join("; ")}`);
  const json = {
    moves: plan.moves.map(({ source: _, ...m }) => m),
    shared: plan.shared,
    missing: plan.missing,
    clashes: plan.clashes,
    orphans: plan.orphans,
    notes: plan.notes.map((n) => ({ ticket: n.note.ticket_id, title: n.note.title, removed: n.body === null })),
    applied: apply,
    stillNaming: left,
  };
  return { text: lines.join("\n"), json };
}
