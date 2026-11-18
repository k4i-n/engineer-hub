import type { Ctx, Result } from "./commands.ts";
import { all, getTicket, one, transaction, type WaitRow } from "./db.ts";
import { afterDuration, HubError, nowIso, nowTs } from "./util.ts";

const MAX_WHO = 120;
const MAX_URL = 2048;

function shown(ctx: Ctx, iso: string): string {
  return nowTs(new Date(iso), ctx.config.timezone);
}

function waitLine(ctx: Ctx, w: WaitRow): string {
  const due = w.ping_after !== null && w.ping_after <= nowIso(ctx.now);
  return [
    `#${w.id} ${w.ticket_id}`,
    w.who,
    `asked ${shown(ctx, w.asked_at)}`,
    w.ping_after === null ? null : due ? "ping now" : `ping after ${shown(ctx, w.ping_after)}`,
    w.url,
  ]
    .filter((part) => part !== null)
    .join(" | ");
}

export function wait(ctx: Ctx, id: string, who: string, url: string, ping: string | null): Result {
  if (!who.trim() || who.length > MAX_WHO) throw new HubError(`who must be 1 to ${MAX_WHO} chars`);
  if (url.length > MAX_URL) throw new HubError(`url is ${url.length} chars (max ${MAX_URL})`);
  getTicket(ctx.db, id);
  const after = ping === null ? null : afterDuration(ctx.now, ping, "--ping-after");
  const at = nowIso(ctx.now);
  const open = one<WaitRow>(
    ctx.db,
    "SELECT * FROM wait WHERE ticket_id = ? AND who = ? AND url = ? AND closed_at IS NULL",
    id,
    who,
    url,
  );
  const waitId = transaction(ctx.db, () => {
    ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(at, id);
    if (open) {
      ctx.db.prepare("UPDATE wait SET ping_after = ? WHERE id = ?").run(after, open.id);
      return open.id;
    }
    const result = ctx.db
      .prepare("INSERT INTO wait(ticket_id, who, url, asked_at, ping_after) VALUES (?, ?, ?, ?, ?)")
      .run(id, who, url, at, after);
    return Number(result.lastInsertRowid);
  });
  const pingNote = after === null ? "" : `, ping after ${shown(ctx, after)}`;
  return {
    text: `wait #${waitId} on ${id}: ${who}${pingNote}`,
    json: { id: waitId, ticket_id: id, who, ping_after: after },
  };
}

export function closeWait(ctx: Ctx, key: string): Result {
  const rows = /^\d+$/.test(key)
    ? all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE id = ? AND closed_at IS NULL", Number(key))
    : all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE url = ? AND closed_at IS NULL", key);
  if (rows.length === 0) throw new HubError(`no open wait ${key} (hub waits lists them)`);
  const at = nowIso(ctx.now);
  transaction(ctx.db, () => {
    for (const w of rows) ctx.db.prepare("UPDATE wait SET closed_at = ? WHERE id = ?").run(at, w.id);
  });
  return { text: `closed ${rows.map((w) => `#${w.id}`).join(", ")}`, json: rows.map((w) => w.id) };
}

export function waits(ctx: Ctx, due: boolean): Result {
  const rows = due
    ? all<WaitRow>(
        ctx.db,
        "SELECT * FROM wait WHERE closed_at IS NULL AND ping_after <= ? ORDER BY ping_after, id",
        nowIso(ctx.now),
      )
    : all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE closed_at IS NULL ORDER BY asked_at, id");
  return { text: rows.map((w) => waitLine(ctx, w)).join("\n") || (due ? "no waits due" : "no open waits"), json: rows };
}
