import type { DatabaseSync } from "node:sqlite";
import { one } from "./db.ts";

export type SlackTeam = { host: string; id: string };

const key = (host: string) => `slack-team:${host}`;

export function saveTeam(db: DatabaseSync, team: SlackTeam): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key(team.host),
    team.id,
  );
}

export function teamOf(db: DatabaseSync, host: string): string | null {
  return one<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key(host))?.value ?? null;
}
