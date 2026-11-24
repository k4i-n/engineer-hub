import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HORIZONS } from "./horizon.ts";
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
  awayPing: boolean;
  awayAfter: string;
  awayEvery: string;
  judgeCommand: string[];
  judgePrompt: string;
  watchFor: string;
  theme: string;
  layout: Layout;
  autoSync: boolean;
  syncEvery: string;
  fetch: Record<string, boolean>;
  fetchEvery: string;
  githubReviewQuery: string;
  githubPrQuery: string;
  reviewAsk: string;
  issueRepo: string;
  slackAlertChannels: SlackChannel[];
  slackIgnoreChannels: SlackChannel[];
  slackGroupChannels: SlackChannel[];
  hiddenBlocks: string[];
  progressStyle: string;
  horizon: string;
  autoBackup: boolean;
  backupEvery: string;
  backupDir: string;
  backupKeep: number;
  laterHour: number;
  recordActions: string[];
};

export type Layout = { top: string[]; left: string[]; right: string[] };

export type SlackChannel = { id: string; name: string };

export const SLACK_CHANNEL_KEYS = ["slackAlertChannels", "slackIgnoreChannels", "slackGroupChannels"] as const;
export type SlackChannelKey = (typeof SLACK_CHANNEL_KEYS)[number];

const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function isChannelKey(key: string): key is SlackChannelKey {
  return (SLACK_CHANNEL_KEYS as readonly string[]).includes(key);
}

export function sameChannel(a: SlackChannel, b: SlackChannel): boolean {
  if (a.id !== "" && b.id !== "") return a.id === b.id;
  return a.name !== "" && a.name === b.name;
}

function channelOf(value: unknown): SlackChannel | null {
  const text = typeof value === "string" ? value.trim().replace(/^#/, "") : "";
  const given =
    typeof value === "string"
      ? CHANNEL_ID.test(text)
        ? { id: text, name: "" }
        : { id: "", name: text }
      : (value as { id?: unknown; name?: unknown } | null);
  if (given === null || typeof given !== "object") return null;
  const { id: rawId = "", name = "" } = given;
  if (typeof rawId !== "string" || typeof name !== "string") return null;
  const id = rawId.trim();
  const bare = name.trim().replace(/^#/, "");
  if (id !== "" && !CHANNEL_ID.test(id)) return null;
  if (bare !== "" && !CHANNEL_NAME.test(bare)) return null;
  if (id === "" && bare === "") return null;
  return { id, name: bare };
}

export function channelList(key: string, value: unknown): SlackChannel[] {
  if (!Array.isArray(value)) throw new HubError(`${key} takes a JSON array of Slack channel names or ids`);
  const list: SlackChannel[] = [];
  for (const v of value) {
    const c = channelOf(v);
    if (c === null)
      throw new HubError(
        `${key} has ${JSON.stringify(v)}, which is not a Slack channel name or id, e.g. ["alerts-prod"] or ["C01ABCDEF"]`,
      );
    if (!list.some((o) => sameChannel(o, c))) list.push(c);
  }
  return list;
}

export const REPO = /^[\w.-]+\/[\w.-]+$/;

const SECTION_ID = /^section-[\p{L}\p{N}-]{1,60}$/u;

export function sectionId(title: string): string {
  return `section-${title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")}`;
}

function knownBlock(id: string): boolean {
  return BLOCKS.includes(id) || SECTION_ID.test(id);
}

export const BLOCKS = [
  "overview",
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
  "activity",
];

export const DEFAULT_LAYOUT: Layout = {
  top: ["overview"],
  left: ["today", "tickets", "activity"],
  right: ["pinned", "fix", "review", "reply", "prs", "triage", "waiting", "decide", "other"],
};

export const MAX_ASK = 200;

export const DEFAULTS: Config = {
  timezone: "Asia/Tokyo",
  ticketIdPattern: "[A-Z]+-\\d+",
  localIdPrefixes: ["DRAFT-", "NEW-"],
  taskDirs: ["inprogress", "todo", "triage", "backlog", "done"],
  openDirs: ["inprogress", "todo", "triage", "backlog", "unfiled"],
  stateFields: ["Status", "Repo", "PRs", "Gate", "Next", "Owner", "Decide", "Order", "Linear"],
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
    "mcp__plugin_engineer-hub_hub,Bash(gh search:*),Bash(gh pr view:*)",
  ],
  openSlackIn: "browser",
  slackTeamId: "",
  openLinearIn: "browser",
  notifyNew: false,
  notifySound: false,
  awayPing: false,
  awayAfter: "10m",
  awayEvery: "30m",
  judgeCommand: [
    "claude",
    "-p",
    "--model",
    "haiku",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--settings",
    '{"alwaysThinkingEnabled":false}',
    "--system-prompt",
    "Answer with JSON only.",
  ],
  judgePrompt:
    "Pick which new items are worth pinging an engineer who is away from the computer. Ping: a question or request to them, someone blocked on them, an alert that matches one of their open tickets or a PR they merged recently (listed below). Skip: thanks, FYI, routine alerts, bot updates.",
  watchFor: "3h",
  theme: "system",
  layout: DEFAULT_LAYOUT,
  autoSync: false,
  syncEvery: "4h",
  fetch: { github: true, linear: false, slack: false },
  fetchEvery: "1m",
  githubReviewQuery: "is:pr is:open review-requested:@me archived:false",
  githubPrQuery: "is:pr author:@me",
  reviewAsk: "Review this?",
  issueRepo: "",
  slackAlertChannels: [],
  slackIgnoreChannels: [],
  slackGroupChannels: [],
  hiddenBlocks: [],
  progressStyle: "ring",
  horizon: "14d",
  autoBackup: true,
  backupEvery: "1d",
  backupDir: "",
  backupKeep: 14,
  laterHour: 9,
  recordActions: [
    "\\bgit\\s+push\\b",
    "\\bgh\\s+pr\\s+(create|merge|comment|review|close|edit)\\b",
    "\\bgh\\s+issue\\s+(create|comment|close|edit)\\b",
  ],
};

const CHOICES: Partial<Record<keyof Config, string[]>> = {
  openSlackIn: ["browser", "app"],
  openLinearIn: ["browser", "app"],
  theme: ["system", "light", "dark"],
  syncEvery: ["15m", "30m", "1h", "2h", "4h"],
  fetchEvery: ["1m", "5m", "15m", "30m"],
  awayAfter: ["5m", "10m", "15m", "30m"],
  awayEvery: ["15m", "30m", "1h", "2h"],
  watchFor: ["1h", "3h", "6h"],
  progressStyle: ["ring", "half", "bar"],
  horizon: HORIZONS,
  backupEvery: ["1h", "6h", "12h", "1d", "7d"],
  backupKeep: ["7", "14", "30"],
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
  if (key === "recordActions") {
    const bad = (value as string[]).find((pattern) => {
      try {
        new RegExp(pattern);
        return false;
      } catch {
        return true;
      }
    });
    if (bad !== undefined) return `recordActions has ${bad}, which is not a valid regular expression`;
  }
  if (key === "syncCommand" && Array.isArray(value) && value.length === 0) {
    return 'syncCommand takes the program and its arguments, e.g. ["claude","-p","/engineer-hub:hub-sync"]';
  }
  if (key === "judgePrompt" && String(value).trim() === "") {
    return "judgePrompt holds the rules for what is worth a ping";
  }
  if (key === "layout") {
    const ids = Object.values(value as Layout).flat();
    const unknown = ids.find((id) => !knownBlock(String(id)));
    if (unknown !== undefined) return `layout has an unknown block ${String(unknown)} (${BLOCKS.join(", ")})`;
    if (new Set(ids).size !== ids.length) return "layout lists a block twice";
  }
  if (key === "hiddenBlocks") {
    const unknown = (value as string[]).find((id) => !knownBlock(id));
    if (unknown !== undefined) return `hiddenBlocks has an unknown block ${unknown} (${BLOCKS.join(", ")})`;
  }
  if (key === "laterHour" && !(Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 23)) {
    return "laterHour is an hour from 0 to 23";
  }
  if (key === "githubReviewQuery" && String(value).trim() === "") {
    return 'githubReviewQuery is a GitHub search, e.g. "is:pr is:open review-requested:@me archived:false"';
  }
  if (key === "githubPrQuery" && String(value).trim() === "") {
    return 'githubPrQuery is a GitHub search, e.g. "is:pr author:@me -repo:acme/noisy"';
  }
  if (key === "issueRepo" && String(value) !== "" && !REPO.test(String(value))) {
    return 'issueRepo is a GitHub repo as owner/name, or "" to use only the ticket\'s repo';
  }
  if (key === "reviewAsk" && (String(value).includes("\n") || String(value).trim().length > MAX_ASK)) {
    return `reviewAsk is one line of at most ${MAX_ASK} chars, or "" for no question`;
  }
  if (key === "backupDir" && !/^($|~$|~\/|\/)/.test(String(value))) {
    return 'backupDir is an absolute folder or ~/..., or "" for backups/ next to the database';
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
    if (isChannelKey(row.key)) {
      config[row.key] = channelList(row.key, value);
      continue;
    }
    const base = DEFAULTS[row.key];
    const isObject = typeof base === "object" && !Array.isArray(base);
    config[row.key] = isObject ? { ...base, ...(value as object) } : value;
  }
  return withKnownBlocks(config as Config);
}

function withKnownBlocks(c: Config): Config {
  const layout = Object.fromEntries(
    Object.entries(c.layout).map(([col, ids]) => [col, (ids as string[]).filter(knownBlock)]),
  ) as Layout;
  return { ...c, layout, hiddenBlocks: c.hiddenBlocks.filter(knownBlock) };
}

export function setConfig(db: DatabaseSync, key: string, raw: string, now: Date): void {
  if (!isKey(key)) throw new HubError(`unknown config key ${key} (${Object.keys(DEFAULTS).join(", ")})`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HubError(`config value must be JSON, e.g. '"Europe/Berlin"' or '["a","b"]'`);
  }
  if (isChannelKey(key)) value = channelList(key, value);
  const error = isChannelKey(key) ? undefined : (shapeError(key, DEFAULTS[key], value) ?? semanticError(key, value));
  if (error) throw new HubError(error);
  db.prepare(
    "INSERT INTO config(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), nowIso(now));
}
