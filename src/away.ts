import { mkdirSync } from "node:fs";
import { type Ctx, openTickets } from "./commands.ts";
import { all, type ItemRow, one, transaction } from "./db.ts";
import { KEYCHAIN_SERVICE, lastLine, type System } from "./keys.ts";
import { afterDuration, cut, HubError, nowIso } from "./util.ts";

export type AwayState = {
  lastPing: string | null;
  lastText: string | null;
  error: string | null;
  lastJudge: string | null;
  judgeError: string | null;
};
export type Candidate = { item: ItemRow; ids: number[] };
export type Verdict = { ping: boolean; why: string };

const WEBHOOK_ACCOUNT = "webhook";
const WEBHOOK_ENV = "HUB_WEBHOOK_KEY";
const COLLAPSE_MS = 2 * 3_600_000;
const NS_PER_MS = 1_000_000;
const JUDGE_TIMEOUT_MS = 90_000;
const TEXT_MAX = 200;
const WHY_MAX = 80;
const ANSWER =
  'Answer with JSON only, one entry per candidate id: {"<id>": {"ping": true or false, "why": "<at most 8 words>"}}';
const EMPTY: AwayState = { lastPing: null, lastText: null, error: null, lastJudge: null, judgeError: null };

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
      known.group.ids.push(item.id);
      continue;
    }
    const group = { item, ids: [item.id] };
    groups.push(group);
    open.set(key, { start: at, group });
  }
  return groups;
}

export function labelOf(i: ItemRow): string {
  return i.kind === "alert" ? "Fix now" : "Reply";
}

export function countText(groups: Candidate[], head = "hub"): string {
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(labelOf(g.item), (counts.get(labelOf(g.item)) ?? 0) + 1);
  const parts = ["Fix now", "Reply"].filter((l) => counts.has(l)).map((l) => `${l} ${counts.get(l)}`);
  return [`${head}: ${groups.length} new`, ...parts].join(" | ");
}

export function prRef(url: string | null): string | null {
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url ?? "");
  return m === null ? null : `${m[1]}#${m[2]}`;
}

export function mergedPrs(ctx: Ctx): ItemRow[] {
  const since = nowIso(new Date(ctx.now.getTime() - durationMs(ctx.config.watchFor, "watchFor")));
  return all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE source = 'github' AND kind = 'pr' AND state = 'merged' AND changed_at > ? ORDER BY changed_at",
    since,
  );
}

export function judgeInput(ctx: Ctx, groups: Candidate[]): string {
  const field = (v: string | null) => cut(v ?? "", TEXT_MAX).replaceAll("|", "/");
  const candidates = groups.map(
    (g) =>
      `${g.item.id} | ${g.item.kind} | ${field(placeOf(g.item))} | ${field(g.item.author)} | ${g.ids.length} | ${field(g.item.title ?? g.item.ref)}`,
  );
  const tickets = openTickets(ctx).map((t) => `${t.id} | ${field(t.title)}`);
  const merged = mergedPrs(ctx).map(
    (p) => `${prRef(p.url) ?? field(p.ref)} | ${field(p.title)} | ${p.ticket_id ?? "-"}`,
  );
  return [
    ctx.config.judgePrompt,
    "",
    "Candidates (id | kind | where | who | repeats | text):",
    ...candidates,
    "",
    "Open tickets (id | title):",
    ...(tickets.length === 0 ? ["none"] : tickets),
    "",
    `My PRs merged in the last ${ctx.config.watchFor} (PR | title | ticket):`,
    ...(merged.length === 0 ? ["none"] : merged),
    "",
    ANSWER,
  ].join("\n");
}

export function parseVerdicts(output: string, groups: Candidate[]): Map<number, Verdict> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  let answer: unknown;
  try {
    answer = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return null;
  const verdicts = new Map<number, Verdict>();
  for (const g of groups) {
    const v = (answer as Record<string, unknown>)[String(g.item.id)] as { ping?: unknown; why?: unknown } | undefined;
    if (typeof v?.ping !== "boolean") continue;
    verdicts.set(g.item.id, { ping: v.ping, why: typeof v.why === "string" ? cut(v.why, WHY_MAX) : "" });
  }
  if (verdicts.size === 0) return null;
  for (const g of groups) if (!verdicts.has(g.item.id)) verdicts.set(g.item.id, { ping: true, why: "no verdict" });
  return verdicts;
}

function saveVerdicts(ctx: Ctx, groups: Candidate[], verdicts: Map<number, Verdict>): void {
  const update = ctx.db.prepare("UPDATE item SET judged_at = ?, away_ping = ?, away_why = ? WHERE id = ?");
  transaction(ctx.db, () => {
    for (const g of groups) {
      const v = verdicts.get(g.item.id);
      if (v === undefined) continue;
      for (const id of g.ids) update.run(nowIso(ctx.now), v.ping ? 1 : 0, v.why, id);
    }
  });
}

export function pingText(picks: { group: Candidate; why: string }[], head = "hub"): string {
  const lines = picks.map(({ group, why }) => {
    const who = group.item.author ? ` (${group.item.author})` : "";
    const times = group.ids.length > 1 ? ` ×${group.ids.length}` : "";
    return `${labelOf(group.item)}: ${placeOf(group.item)}${who}${times}${why === "" ? "" : `, ${why}`}`;
  });
  return [`${head}: ${picks.length} need you`, ...lines].join("\n");
}

function sampleGroup(kind: string, place: string, author: string, count: number): Candidate {
  const item: ItemRow = {
    id: 0,
    source: "slack",
    ref: "",
    kind,
    title: `${place} · ${author}: sample`,
    url: null,
    state: null,
    author,
    ticket_id: null,
    needs_me: 1,
    first_seen: "",
    changed_at: "",
    closed_at: null,
    snoozed_until: null,
    ignored: null,
    detached: 0,
    judged_at: null,
    away_ping: null,
    away_why: null,
    body: null,
    detail: null,
  };
  return { item, ids: Array.from({ length: count }, (_, i) => i) };
}

export function sampleText(judged: boolean): string {
  const reply = sampleGroup("message", "#help-desk", "ana", 1);
  const alert = sampleGroup("alert", "#alerts", "Grafana", 3);
  if (!judged) return countText([alert, reply, sampleGroup("message", "DM", "bo", 1)], "hub test");
  return pingText(
    [
      { group: reply, why: "asks you to confirm app scopes" },
      { group: alert, why: "matches ENG-12 after web#123 merge" },
    ],
    "hub test",
  );
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
  private readonly judgeDir: string;

  constructor(sys: System, ctx: () => Ctx, judgeDir: string) {
    this.sys = sys;
    this.ctx = ctx;
    this.judgeDir = judgeDir;
  }

  async lookup(): Promise<string | null> {
    const url = await webhookUrl(this.sys);
    this.hasUrl = url !== null;
    return url;
  }

  async test(): Promise<string> {
    const url = await this.lookup();
    if (url === null) throw new HubError(`no webhook URL: ${webhookCommand(this.sys.platform)}`);
    const text = sampleText(this.ctx().config.judgeCommand.length > 0);
    await postWebhook(this.sys, url, text);
    return `posted ${text.split("\n")[0]}`;
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
    const groups = collapse(candidates(c, since)).filter((g) => g.item.away_ping !== 0);
    if (groups.length === 0) return;
    const text = await this.decide(c, groups);
    if (text === null) return;
    const url = await this.lookup();
    if (url === null) throw new HubError(`no webhook URL: ${webhookCommand(this.sys.platform)}`);
    await postWebhook(this.sys, url, text);
    saveAwayState(c, { ...awayState(c), lastPing: nowIso(c.now), lastText: text, error: null });
  }

  private async decide(c: Ctx, groups: Candidate[]): Promise<string | null> {
    if (c.config.judgeCommand.length === 0) return countText(groups);
    const fresh = groups.filter((g) => g.item.judged_at === null);
    const verdicts = new Map<number, Verdict>();
    if (fresh.length > 0) {
      const judged = await this.judge(c, fresh);
      if (judged === null) return `${countText(groups)}, judge failed`;
      saveVerdicts(c, fresh, judged);
      for (const [id, v] of judged) verdicts.set(id, v);
    }
    const picks = groups.flatMap((group) => {
      const v = verdicts.get(group.item.id) ?? { ping: group.item.away_ping === 1, why: group.item.away_why ?? "" };
      return v.ping ? [{ group, why: v.why }] : [];
    });
    return picks.length === 0 ? null : pingText(picks);
  }

  private async judge(c: Ctx, groups: Candidate[]): Promise<Map<number, Verdict> | null> {
    const [program = "", ...args] = c.config.judgeCommand;
    mkdirSync(this.judgeDir, { recursive: true });
    const ran = await this.sys.run(program, args, {
      input: judgeInput(c, groups),
      timeoutMs: JUDGE_TIMEOUT_MS,
      cwd: this.judgeDir,
    });
    const verdicts = ran.code === 0 ? parseVerdicts(ran.stdout, groups) : null;
    const error =
      ran.code !== 0
        ? `judge exit ${ran.code}: ${lastLine(ran.stderr || ran.stdout)}`
        : verdicts === null
          ? "judge answer was not JSON with a verdict per id"
          : null;
    saveAwayState(c, { ...awayState(c), lastJudge: nowIso(c.now), judgeError: error });
    return verdicts;
  }
}
