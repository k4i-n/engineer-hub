import type { Ctx, Result } from "./commands.ts";
import { all, one, type SourceRow } from "./db.ts";
import { cut, HubError, nowIso, nowTs } from "./util.ts";

export const SOURCE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_CURSOR = 2048;
const MAX_ERROR = 240;

export type SyncOptions = { cursor: string | null; error: string | null; warning?: string | null };

export function synced(ctx: Ctx, name: string, options: SyncOptions): Result {
  if (!SOURCE_NAME.test(name))
    throw new HubError(`source must be a lowercase name such as github or slack, not ${name}`);
  if (options.cursor !== null && options.cursor.length > MAX_CURSOR) {
    throw new HubError(`--cursor is ${options.cursor.length} chars (max ${MAX_CURSOR})`);
  }
  const error = options.error === null ? null : cut(options.error, MAX_ERROR);
  const warning = options.warning == null ? null : cut(options.warning, MAX_ERROR);
  ctx.db
    .prepare(
      `INSERT INTO source(name, cursor, last_sync, last_error, warning) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET cursor = coalesce(excluded.cursor, source.cursor),
         last_sync = excluded.last_sync, last_error = excluded.last_error, warning = excluded.warning`,
    )
    .run(name, options.cursor, nowIso(ctx.now), error, warning);
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
      s.warning === null ? null : `warning: ${s.warning}`,
    ]
      .filter((part) => part !== null)
      .join(" | "),
  );
  const scripts = all<{ name: string; argv: string; every: string }>(
    ctx.db,
    "SELECT * FROM script_source ORDER BY name",
  );
  for (const sc of scripts)
    lines.push(`script ${sc.name}: ${(JSON.parse(sc.argv) as string[]).join(" ")} | every ${sc.every}`);
  return { text: lines.join("\n") || "no sources synced yet", json: { sources: rows, scripts } };
}
