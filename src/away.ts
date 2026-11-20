import type { Ctx } from "./commands.ts";
import { all, type ItemRow, one } from "./db.ts";
import { KEYCHAIN_SERVICE, lastLine, type System } from "./keys.ts";
import { afterDuration, HubError, nowIso } from "./util.ts";

export type AwayState = {
  lastPing: string | null;
  lastText: string | null;
  error: string | null;
};
export type Candidate = { item: ItemRow; count: number };

const WEBHOOK_ACCOUNT = "webhook";
const WEBHOOK_ENV = "HUB_WEBHOOK_KEY";
const COLLAPSE_MS = 2 * 3_600_000;
const NS_PER_MS = 1_000_000;
const EMPTY: AwayState = { lastPing: null, lastText: null, error: null };

export function durationMs(value: string, flag: string): number {
  return Date.parse(afterDuration(new Date(0), value, flag));
}

export type Idle = { ms: number; locked: boolean };

export async function idleNow(sys: System): Promise<Idle | null> {
  if (sys.platform !== "darwin") return null;
  const hid = await sys.run("ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
  const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid.stdout)?.[1];
  if (hid.code !== 0 || idle === undefined) return null;
  const root = await sys.run("ioreg", ["-n", "Root", "-d", "1"]);
  return {
    ms: Math.floor(Number(idle) / NS_PER_MS),
    locked: /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(root.stdout),
  };
}

export function awayState(ctx: Ctx): AwayState {
  const value = one<{ value: string }>(ctx.db, "SELECT value FROM meta WHERE key = 'away'")?.value;
  return value === undefined ? EMPTY : { ...EMPTY, ...(JSON.parse(value) as Partial<AwayState>) };
}

export function saveAwayState(ctx: Ctx, state: AwayState): void {
  ctx.db
    .prepare("INSERT INTO meta(key, value) VALUES ('away', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(state));
}

export function candidates(ctx: Ctx, since: string): ItemRow[] {
  return all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE needs_me = 1 AND closed_at IS NULL AND ignored IS NULL
       AND (snoozed_until IS NULL OR snoozed_until <= ?)
       AND kind IN ('alert', 'message', 'thread', 'mail') AND first_seen > ?
     ORDER BY first_seen, id`,
    nowIso(ctx.now),
    since,
  );
}

export function placeOf(i: ItemRow): string {
  const title = i.title ?? "";
  if (i.source === "slack" && title.includes(" · ")) return title.split(" · ")[0] as string;
  if (i.source === "linear" && title !== "") return title.split(" ")[0] as string;
  return i.ticket_id ?? i.source;
}

function repeatKey(i: ItemRow): string {
  if (i.kind === "alert") return `alert|${(i.title ?? i.ref).replace(/\d+/g, "")}`;
  return `${i.kind}|${placeOf(i)}|${i.author ?? ""}`;
}

export function collapse(rows: ItemRow[]): Candidate[] {
  const open = new Map<string, { start: number; group: Candidate }>();
  const groups: Candidate[] = [];
  for (const item of rows) {
    const key = repeatKey(item);
    const at = Date.parse(item.first_seen);
    const known = open.get(key);
    if (known !== undefined && at - known.start <= COLLAPSE_MS) {
      known.group.item = item;
      known.group.count++;
      continue;
    }
    const group = { item, count: 1 };
    groups.push(group);
    open.set(key, { start: at, group });
  }
  return groups;
}

export function labelOf(i: ItemRow): string {
  return i.kind === "alert" ? "Fix now" : "Reply";
}

export function countText(groups: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(labelOf(g.item), (counts.get(labelOf(g.item)) ?? 0) + 1);
  const parts = ["Fix now", "Reply"].filter((l) => counts.has(l)).map((l) => `${l} ${counts.get(l)}`);
  return [`hub: ${groups.length} new`, ...parts].join(" | ");
}

export function slackSafe(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export async function webhookUrl(sys: System): Promise<string | null> {
  let url = sys.env[WEBHOOK_ENV] ?? "";
  if (sys.platform === "darwin") {
    const item = await sys.run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      WEBHOOK_ACCOUNT,
      "-w",
    ]);
    if (item.code === 0) url = item.stdout.trim();
  }
  return url.startsWith("https://") ? url : null;
}

export function webhookCommand(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${WEBHOOK_ACCOUNT} -w`
    : `export ${WEBHOOK_ENV}=https://...`;
}

export async function postWebhook(sys: System, url: string, text: string): Promise<void> {
  let status: number;
  try {
    const r = await sys.http(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: slackSafe(text) }),
    });
    status = r.status;
  } catch {
    throw new HubError("webhook post failed: no answer");
  }
  if (status >= 400) throw new HubError(`webhook answered ${status}`);
}

export class Away {
  private running = false;
  hasUrl: boolean | null = null;
  private readonly sys: System;
  private readonly ctx: () => Ctx;

  constructor(sys: System, ctx: () => Ctx) {
    this.sys = sys;
    this.ctx = ctx;
  }

  async lookup(): Promise<string | null> {
    const url = await webhookUrl(this.sys);
    this.hasUrl = url !== null;
    return url;
  }

  async test(): Promise<string> {
    const url = await this.lookup();
    if (url === null) throw new HubError(`no webhook URL: ${webhookCommand(this.sys.platform)}`);
    await postWebhook(this.sys, url, "hub: test");
    return "posted hub: test";
  }

  async check(): Promise<void> {
    if (this.running || !this.ctx().config.awayPing) return;
    this.running = true;
    try {
      if (this.hasUrl === null) await this.lookup();
      await this.pingIfDue();
    } catch (error) {
      const c = this.ctx();
      saveAwayState(c, { ...awayState(c), error: error instanceof Error ? lastLine(error.message) : String(error) });
    } finally {
      this.running = false;
    }
  }

  private async pingIfDue(): Promise<void> {
    const idle = await idleNow(this.sys);
    const c = this.ctx();
    if (idle === null || (!idle.locked && idle.ms < durationMs(c.config.awayAfter, "awayAfter"))) return;
    const state = awayState(c);
    const now = c.now.getTime();
    if (state.lastPing !== null && now - Date.parse(state.lastPing) < durationMs(c.config.awayEvery, "awayEvery")) {
      return;
    }
    const lastActive = nowIso(new Date(now - idle.ms));
    const since = state.lastPing !== null && state.lastPing > lastActive ? state.lastPing : lastActive;
    const groups = collapse(candidates(c, since));
    if (groups.length === 0) return;
    const url = await this.lookup();
    if (url === null) throw new HubError(`no webhook URL: ${webhookCommand(this.sys.platform)}`);
    const text = countText(groups);
    await postWebhook(this.sys, url, text);
    saveAwayState(c, { lastPing: nowIso(c.now), lastText: text, error: null });
  }
}
