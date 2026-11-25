import type { DatabaseSync } from "node:sqlite";
import { all, one } from "./db.ts";

export type SlackTeam = { host: string; id: string };

const key = (host: string) => `slack-team:${host}`;

export function saveTeam(db: DatabaseSync, team: SlackTeam): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key(team.host),
    team.id,
  );
}

export function workspaceOf(url: string | null): string | null {
  return /^https:\/\/([a-z0-9-]+)\.(?:[a-z0-9-]+\.)*slack\.com\//.exec(url ?? "")?.[1] ?? null;
}

export function workspacesByTeam(db: DatabaseSync): Map<string, string> {
  const rows = all<{ key: string; value: string }>(db, "SELECT key, value FROM meta WHERE key LIKE 'slack-team:%'");
  return new Map(rows.map((r) => [r.value, r.key.slice("slack-team:".length).split(".")[0] ?? ""]));
}

export function teamOf(db: DatabaseSync, host: string): string | null {
  return one<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key(host))?.value ?? null;
}
