import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HubError, nowIso } from "./util.ts";

export type Config = {
  timezone: string;
  ticketIdPattern: string;
  localIdPrefixes: string[];
  taskDirs: string[];
  openDirs: string[];
  stateFields: string[];
  limits: Record<string, number>;
  sections: Record<string, string>;
  trackerSyncMarkers: string[];
  trackerHosts: string[];
  planDir: string;
  resumeHeading: string;
  syncCommand: string[];
  openSlackIn: string;
  slackTeamId: string;
  openLinearIn: string;
  notifyNew: boolean;
  notifySound: boolean;
  theme: string;
  layout: Layout;
};

export type Layout = { left: string[]; right: string[] };

export const BLOCKS = [
  "pinned",
  "fix",
  "review",
  "reply",
  "prs",
  "triage",
  "waiting",
  "decide",
  "other",
  "tickets",
  "today",
  "drafts",
  "activity",
];

export const DEFAULT_LAYOUT: Layout = {
  left: ["today", "tickets"],
  right: ["pinned", "fix", "review", "reply", "prs", "triage", "waiting", "decide", "other", "drafts", "activity"],
};

export const DEFAULTS: Config = {
  timezone: "Asia/Tokyo",
  ticketIdPattern: "[A-Z]+-\\d+",
  localIdPrefixes: ["DRAFT-", "NEW-"],
  taskDirs: ["inprogress", "todo", "triage", "backlog", "done"],
  openDirs: ["inprogress", "todo", "triage", "backlog", "unfiled"],
  stateFields: ["Status", "Repo", "PRs", "Gate", "Next", "Owner", "Decide", "Linear"],
  limits: { status: 240, repo: 240, prs: 240, gate: 240, decide: 240, next: 240, owner: 120 },
  sections: { body: "Ticket body as filed", detail: "Detail", log: "Log", messages: "Messages" },
  trackerSyncMarkers: ["<!-- linear-sync:start", "<!-- linear-sync:end"],
  trackerHosts: ["linear.app"],
  planDir: "plan",
  resumeHeading: "RESUME",
  syncCommand: [
    "claude",
    "-p",
    "/engineer-hub:hub-sync",
    "--allowedTools",
    "Bash(hub:*),Bash(gh search:*),Bash(gh pr view:*)",
  ],
  openSlackIn: "browser",
  slackTeamId: "",
  openLinearIn: "browser",
  notifyNew: false,
  notifySound: false,
  theme: "system",
  layout: DEFAULT_LAYOUT,
};

const CHOICES: Partial<Record<keyof Config, string[]>> = {
  openSlackIn: ["browser", "app"],
  openLinearIn: ["browser", "app"],
  theme: ["system", "light", "dark"],
};

type Key = keyof Config;

export function dbPath(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const path = flag ?? env.HUB_DB ?? join(homedir(), ".hub", "hub.db");
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return path;
}

function isKey(key: string): key is Key {
  return Object.hasOwn(DEFAULTS, key);
}

function shapeError(key: string, expected: unknown, value: unknown): string | undefined {
  if (Array.isArray(expected)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
      return `${key} takes a JSON array of strings`;
    return undefined;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${key} takes a JSON object`;
    const sample = Object.values(expected)[0];
    for (const [k, v] of Object.entries(value)) {
      if (!Object.hasOwn(expected, k)) return `${key}.${k} is not a known key (${Object.keys(expected).join(", ")})`;
      if (typeof v !== typeof sample) return `${key}.${k} takes a ${typeof sample}`;
    }
    return undefined;
  }
  if (typeof value !== typeof expected) return `${key} takes a JSON ${typeof expected}`;
  return undefined;
}

function semanticError(key: Key, value: unknown): string | undefined {
  const choices = CHOICES[key];
  if (choices !== undefined && !choices.includes(String(value))) return `${key} must be one of ${choices.join(", ")}`;
  if (key === "slackTeamId" && !/^(T[A-Z0-9]{4,20})?$/.test(String(value))) {
    return "slackTeamId is the workspace id, e.g. T01ABCDEF";
  }
  if (key === "timezone") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(value) });
    } catch {
      return `timezone ${String(value)} is not an IANA time zone`;
    }
  }
  if (key === "ticketIdPattern") {
    try {
      new RegExp(String(value));
    } catch {
      return `ticketIdPattern is not a valid regular expression`;
    }
  }
  if (key === "syncCommand" && Array.isArray(value) && value.length === 0) {
    return 'syncCommand takes the program and its arguments, e.g. ["claude","-p","/engineer-hub:hub-sync"]';
  }
  if (key === "layout") {
    const ids = Object.values(value as Layout).flat();
    const unknown = ids.find((id) => !BLOCKS.includes(String(id)));
    if (unknown !== undefined) return `layout has an unknown block ${String(unknown)} (${BLOCKS.join(", ")})`;
    if (new Set(ids).size !== ids.length) return "layout lists a block twice";
  }
  if (key === "trackerSyncMarkers" && Array.isArray(value) && value.length !== 2) {
    return "trackerSyncMarkers takes exactly two strings: start and end";
  }
  return undefined;
}

export function loadConfig(db: DatabaseSync): Config {
  const config: Record<string, unknown> = structuredClone(DEFAULTS);
  const rows = db.prepare("SELECT key, value FROM config").all() as { key: string; value: string }[];
  for (const row of rows) {
    if (!isKey(row.key)) continue;
    const value: unknown = JSON.parse(row.value);
    const base = DEFAULTS[row.key];
    const isObject = typeof base === "object" && !Array.isArray(base);
    config[row.key] = isObject ? { ...base, ...(value as object) } : value;
  }
  return config as Config;
}

export function setConfig(db: DatabaseSync, key: string, raw: string, now: Date): void {
  if (!isKey(key)) throw new HubError(`unknown config key ${key} (${Object.keys(DEFAULTS).join(", ")})`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HubError(`config value must be JSON, e.g. '"Europe/Berlin"' or '["a","b"]'`);
  }
  const error = shapeError(key, DEFAULTS[key], value) ?? semanticError(key, value);
  if (error) throw new HubError(error);
  db.prepare(
    "INSERT INTO config(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), nowIso(now));
}
