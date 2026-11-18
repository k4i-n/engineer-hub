import type { Ctx, Result } from "./commands.ts";
import { all, one, type SourceRow } from "./db.ts";
import { cut, HubError, nowIso, nowTs } from "./util.ts";

export const SOURCE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_CURSOR = 2048;
const MAX_ERROR = 240;

export type SyncOptions = { cursor: string | null; error: string | null };

export function synced(ctx: Ctx, name: string, options: SyncOptions): Result {
  if (!SOURCE_NAME.test(name))
    throw new HubError(`source must be a lowercase name such as github or slack, not ${name}`);
  if (options.cursor !== null && options.cursor.length > MAX_CURSOR) {
    throw new HubError(`--cursor is ${options.cursor.length} chars (max ${MAX_CURSOR})`);
  }
  const error = options.error === null ? null : cut(options.error, MAX_ERROR);
  ctx.db
    .prepare(
      `INSERT INTO source(name, cursor, last_sync, last_error) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET cursor = coalesce(excluded.cursor, source.cursor),
         last_sync = excluded.last_sync, last_error = excluded.last_error`,
    )
    .run(name, options.cursor, nowIso(ctx.now), error);
  const row = one<SourceRow>(ctx.db, "SELECT * FROM source WHERE name = ?", name);
  return { text: `source ${name} synced${error === null ? "" : ", with error"}`, json: row };
}

export function sources(ctx: Ctx): Result {
  const rows = all<SourceRow>(ctx.db, "SELECT * FROM source ORDER BY name");
  const lines = rows.map((s) =>
    [
      s.name,
      `last sync ${nowTs(new Date(s.last_sync), ctx.config.timezone)}`,
      s.cursor === null ? null : `cursor ${cut(s.cursor, 60)}`,
      s.last_error === null ? null : `error: ${s.last_error}`,
    ]
      .filter((part) => part !== null)
      .join(" | "),
  );
  return { text: lines.join("\n") || "no sources synced yet", json: rows };
}
