import type { Ctx, Result } from "./commands.ts";
import { sectionId } from "./config.ts";
import { all, one, type ScriptRow } from "./db.ts";
import type { Fetcher } from "./fetch.ts";
import { lastLine } from "./keys.ts";
import { SOURCE_NAME } from "./sources.ts";
import { afterDuration, HubError, nowIso } from "./util.ts";

const SCRIPT_TIMEOUT_MS = 2 * 60_000;
const RESERVED = ["add", "remove", "set", "github", "linear", "slack"];

export function addScript(ctx: Ctx, name: string, every: string, argv: string[]): Result {
  if (!SOURCE_NAME.test(name) || RESERVED.includes(name) || name.startsWith("slack-")) {
    throw new HubError(
      `a script source needs its own lowercase name, not ${name} (${RESERVED.join(", ")} and slack-* are taken)`,
    );
  }
  afterDuration(new Date(0), every, "--every");
  if (argv.length === 0)
    throw new HubError("give the program after --: hub source add <name> --every 5m -- <program> [args]");
  ctx.db
    .prepare(
      `INSERT INTO script_source(name, argv, every, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET argv = excluded.argv, every = excluded.every`,
    )
    .run(name, JSON.stringify(argv), every, nowIso(ctx.now));
  return { text: `script source ${name}: ${argv.join(" ")}, every ${every}`, json: { name, argv, every } };
}

export function removeScript(ctx: Ctx, name: string): Result {
  if (one(ctx.db, "SELECT 1 FROM script_source WHERE name = ?", name) === undefined) {
    throw new HubError(`no script source ${name} (hub sources lists them)`);
  }
  ctx.db.prepare("DELETE FROM script_source WHERE name = ?").run(name);
  return { text: `script source ${name} removed`, json: { name } };
}

const MAX_SECTION = 40;

export type ScriptChange = { on: boolean | null; every: string | null; section: string | null };

function sectionTitle(raw: string): string | null {
  const title = raw.trim();
  if (title === "") return null;
  if (title.length > MAX_SECTION || /[\r\n]/.test(title) || sectionId(title) === "section-") {
    throw new HubError(
      `a section is a card title of 1 to ${MAX_SECTION} characters with a letter or digit, not ${raw}`,
    );
  }
  return title;
}

export function setScript(ctx: Ctx, name: string, change: ScriptChange): Result {
  const row = one<ScriptRow>(ctx.db, "SELECT * FROM script_source WHERE name = ?", name);
  if (row === undefined) throw new HubError(`no script source ${name} (hub sources lists them)`);
  if (change.every !== null) afterDuration(new Date(0), change.every, "every");
  const on = change.on ?? row.enabled === 1;
  const every = change.every ?? row.every;
  const section = change.section === null ? row.section : sectionTitle(change.section);
  ctx.db
    .prepare("UPDATE script_source SET enabled = ?, every = ?, section = ? WHERE name = ?")
    .run(on ? 1 : 0, every, section, name);
  const shown = section === null ? "" : `, section ${section}`;
  return {
    text: `script source ${name}: ${on ? "on" : "off"}, every ${every}${shown}`,
    json: { name, on, every, section },
  };
}

export function sections(ctx: Ctx): Map<string, string> {
  const rows = all<ScriptRow>(ctx.db, "SELECT * FROM script_source WHERE section IS NOT NULL ORDER BY name");
  return new Map(rows.map((r) => [r.name, r.section ?? ""]));
}

export function scripts(ctx: Ctx): ScriptRow[] {
  return all<ScriptRow>(ctx.db, "SELECT * FROM script_source ORDER BY name");
}

export function scriptFetcher(row: ScriptRow): Fetcher {
  const argv = JSON.parse(row.argv) as string[];
  const [program, ...args] = argv as [string, ...string[]];
  return {
    name: row.name,
    key: null,
    every: row.every,
    argv,
    on: row.enabled === 1,
    section: row.section,
    check: async () => ({ ok: true, how: `runs ${argv.join(" ")}`, fix: [] }),
    fetch: async (sys, ctx, cursor) => {
      const started = ctx.now.toISOString();
      const r = await sys.run(program, args, { timeoutMs: SCRIPT_TIMEOUT_MS, env: { HUB_SINCE: cursor ?? "" } });
      if (r.timedOut) throw new HubError(`timed out after ${SCRIPT_TIMEOUT_MS / 60_000}m`);
      if (r.code !== 0) throw new HubError(`exit ${r.code}: ${lastLine(r.stderr) || "no output on stderr"}`);
      const items = r.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line, index) => {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw new HubError(`line ${index + 1}: not JSON`);
          }
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new HubError(`line ${index + 1}: must be a JSON object`);
          }
          return { source: row.name, ...(value as Record<string, unknown>) };
        });
      return { items, cursor: started };
    },
  };
}
