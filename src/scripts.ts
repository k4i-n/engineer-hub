import type { Ctx, Result } from "./commands.ts";
import { all, one, type ScriptRow } from "./db.ts";
import type { Fetcher } from "./fetch.ts";
import { lastLine } from "./keys.ts";
import { SOURCE_NAME } from "./sources.ts";
import { afterDuration, HubError, nowIso } from "./util.ts";

const SCRIPT_TIMEOUT_MS = 2 * 60_000;
const RESERVED = ["add", "remove", "github", "linear", "slack"];

export function addScript(ctx: Ctx, name: string, every: string, argv: string[]): Result {
  if (!SOURCE_NAME.test(name) || RESERVED.includes(name)) {
    throw new HubError(`a script source needs its own lowercase name, not ${name} (${RESERVED.join(", ")} are taken)`);
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
    check: async () => ({ ok: true, how: `runs ${argv.join(" ")}`, fix: [] }),
    fetch: async (sys, ctx, cursor) => {
      const started = ctx.now.toISOString();
      const r = await sys.run(program, args, { timeoutMs: SCRIPT_TIMEOUT_MS, env: { HUB_SINCE: cursor ?? "" } });
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
