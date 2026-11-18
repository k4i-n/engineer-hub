import type { DatabaseSync } from "node:sqlite";
import type { Ctx, Result } from "./commands.ts";
import { all } from "./db.ts";
import { HubError, nowIso } from "./util.ts";

const PIN_KEY = /^(item|wait|match|gate|decide)-.{1,300}$/;

export function setPin(ctx: Ctx, key: string, on: boolean): Result {
  if (!PIN_KEY.test(key)) throw new HubError(`not a row key: ${key}`);
  if (on) ctx.db.prepare("INSERT OR IGNORE INTO pin(key, pinned_at) VALUES (?, ?)").run(key, nowIso(ctx.now));
  else ctx.db.prepare("DELETE FROM pin WHERE key = ?").run(key);
  return { text: `${key} ${on ? "pinned" : "unpinned"}`, json: { key, pinned: on } };
}

export function pins(db: DatabaseSync): Map<string, string> {
  return new Map(all<{ key: string; pinned_at: string }>(db, "SELECT * FROM pin").map((p) => [p.key, p.pinned_at]));
}
