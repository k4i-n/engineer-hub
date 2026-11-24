import type { Ctx } from "../commands.ts";
import { SLACK_CHANNEL_KEYS, type SlackChannel, type SlackChannelKey } from "../config.ts";
import { all, type ItemRow, type WaitRow } from "../db.ts";
import type { Fetched, Fetcher } from "../fetch.ts";
import { findWay, HttpError, type KeySpec, keyedCall, type System, type Way } from "../keys.ts";
import { clip, cut, HubError } from "../util.ts";
import { keyCheck, keyWay } from "./keyed.ts";

const FIRST_LOOK_S = 2 * 86_400;
const DAY_S = 86_400;
const THREAD_LOOK_S = 3 * DAY_S;
const THREADS = 20;
const DONE_REACTIONS = new Set(["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "done"]);
const RECHECK = 30;
const MAX_BODY = 4000;
const NO_SCOPE = new Set(["missing_scope", "no_permission", "not_allowed_token_type"]);
const SLACKBOT = "USLACKBOT";
const LIST_PAGES = 20;

export const SLACK_KEY: KeySpec = {
  source: "slack",
  host: "slack.com",
  header: "Authorization: Bearer {key}",
  allow: [
    "GET /api/auth.test",
    "GET /api/search.messages",
    "GET /api/conversations.replies",
    "GET /api/conversations.info",
    "GET /api/conversations.list",
    "GET /api/users.info",
    "GET /api/usergroups.list",
    "GET /api/reactions.get",
  ],
};

type Channel = { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string };
type Attachment = { fallback?: string; pretext?: string; title?: string; text?: string; blocks?: unknown[] };
type Match = {
  ts: string;
  text: string;
  attachments?: Attachment[];
  blocks?: unknown[];
  permalink: string;
  user?: string;
  username?: string;
  bot_id?: string;
  channel?: Channel;
};
type Reaction = { name: string; users: string[] };
type User = {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; image_48?: string };
};
type Group = { id: string; handle: string; users?: string[] };
type Answer = { ok: boolean; error?: string; needed?: string };

class SlackError extends HubError {
  readonly code: string;
  readonly needed: string | null;
  constructor(method: string, code: string, needed: string | null) {
    super(`slack ${method}: ${code}`);
    this.code = code;
    this.needed = needed;
  }
}

async function slackGet<T extends Answer>(
  sys: System,
  way: Way,
  method: string,
  args: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(args).toString();
  const text = await keyedCall(sys, way, SLACK_KEY, "GET", `/api/${method}${query ? `?${query}` : ""}`);
  const answer = JSON.parse(text) as T;
  if (!answer.ok) throw new SlackError(method, answer.error ?? "not ok", answer.needed ?? null);
  return answer;
}

export function threadOf(url: string): { channel: string; ts: string } | null {
  const m = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/.exec(url);
  if (m === null) return null;
  const thread = new URLSearchParams(m[4] ?? "").get("thread_ts");
  return { channel: m[1] as string, ts: thread ?? `${m[2]}.${m[3]}` };
}

export function messageOf(url: string): { channel: string; ts: string } | null {
  const m = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url);
  return m === null ? null : { channel: m[1] as string, ts: `${m[2]}.${m[3]}` };
}

function conversationScope(channel: Channel | string): string {
  const c = typeof channel === "string" ? { id: channel } : channel;
  if (c.is_im === true || c.id.startsWith("D")) return "im:read";
  if (c.is_mpim === true) return "mpim:read";
  if (c.is_private === true || c.id.startsWith("G")) return "groups:read";
  return "channels:read";
}

function transient(error: unknown): string | null {
  if (error instanceof SlackError) return NO_SCOPE.has(error.code) ? null : error.code;
  if (error instanceof HttpError && (error.status === 429 || error.status >= 500)) return error.message;
  return null;
}

class Directory {
  readonly missing = new Set<string>();
  readonly failed = new Set<string>();
  private readonly users = new Map<string, string | null>();
  private readonly bots = new Map<string, boolean>();
  private readonly avatars = new Map<string, string | null>();
  private readonly channels = new Map<string, Channel | null>();
  private groups: Group[] | null = null;
  private named: Map<string, string> | null | undefined;
  private readonly sys: System;
  private readonly way: Way;

  constructor(sys: System, way: Way, known: Match[]) {
    this.sys = sys;
    this.way = way;
    this.learn(known);
  }

  learn(known: Match[]): void {
    for (const m of known) if (m.user && m.username && !this.users.has(m.user)) this.users.set(m.user, m.username);
  }

  private async soft<T extends Answer>(method: string, args: Record<string, string>, scope: string): Promise<T | null> {
    try {
      return await slackGet<T>(this.sys, this.way, method, args);
    } catch (error) {
      const failure = transient(error);
      if (failure !== null) this.failed.add(`${method} ${failure}`);
      else this.missing.add(error instanceof SlackError ? (error.needed ?? scope) : scope);
      return null;
    }
  }

  private async lookup(id: string): Promise<void> {
    const r = await this.soft<Answer & { user: User }>("users.info", { user: id }, "users:read");
    const u = r?.user;
    const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || null;
    this.users.set(id, name ?? this.users.get(id) ?? null);
    this.avatars.set(id, u?.profile?.image_48 ?? null);
    if (r !== null || this.missing.has("users:read")) this.bots.set(id, u?.is_bot === true);
  }

  async user(id: string): Promise<string> {
    if (!this.users.has(id) || this.users.get(id) === null) await this.lookup(id);
    return this.users.get(id) ?? id;
  }

  async avatar(id: string): Promise<string | null> {
    if (!this.avatars.has(id)) await this.lookup(id);
    return this.avatars.get(id) ?? null;
  }

  async fromApp(m: Match): Promise<boolean | null> {
    if (m.bot_id !== undefined || m.user === undefined || m.user === SLACKBOT) return true;
    if (!this.bots.has(m.user)) await this.lookup(m.user);
    return this.bots.get(m.user) ?? null;
  }

  async channel(id: string, hint: Channel = { id }): Promise<Channel> {
    if (!this.channels.has(id)) {
      const r = await this.soft<Answer & { channel: Channel }>(
        "conversations.info",
        { channel: id },
        conversationScope(hint),
      );
      this.channels.set(id, r?.channel ?? null);
    }
    return { ...hint, ...(this.channels.get(id) ?? {}) };
  }

  async idsByName(): Promise<Map<string, string> | null> {
    if (this.named !== undefined) return this.named;
    const named = new Map<string, string>();
    let cursor = "";
    for (let page = 0; page < LIST_PAGES; page++) {
      const r = await this.soft<Answer & { channels: Channel[]; response_metadata?: { next_cursor?: string } }>(
        "conversations.list",
        { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", cursor },
        "channels:read",
      );
      if (r === null) {
        this.named = null;
        return null;
      }
      for (const c of r.channels) if (c.name) named.set(c.name, c.id);
      cursor = r.response_metadata?.next_cursor ?? "";
      if (cursor === "") break;
    }
    this.named = named;
    return named;
  }

  private async allGroups(): Promise<Group[]> {
    if (this.groups === null) {
      const r = await this.soft<Answer & { usergroups: Group[] }>(
        "usergroups.list",
        { include_users: "true" },
        "usergroups:read",
      );
      this.groups = r?.usergroups ?? [];
    }
    return this.groups;
  }

  async group(id: string): Promise<string> {
    return (await this.allGroups()).find((g) => g.id === id)?.handle ?? id;
  }

  async groupsOf(user: string): Promise<Group[]> {
    return (await this.allGroups()).filter((g) => g.users?.includes(user) === true);
  }

  async replies(channel: string, ts: string, oldest: string): Promise<Match[]> {
    const r = await this.soft<Answer & { messages: Match[] }>(
      "conversations.replies",
      { channel, ts, oldest, limit: "100" },
      "channels:history",
    );
    return r?.messages ?? [];
  }

  async reactions(channel: string, ts: string): Promise<{ user: string | null; reactions: Reaction[] } | null> {
    const r = await this.soft<Answer & { message?: { user?: string; reactions?: Reaction[] } }>(
      "reactions.get",
      { channel, timestamp: ts, full: "true" },
      "reactions:read",
    );
    return r === null ? null : { user: r.message?.user ?? null, reactions: r.message?.reactions ?? [] };
  }
}

export type Resolved = { channels: SlackChannel[]; unknown: string[]; unresolved: string[]; why: string };

function lookupFailure(dir: Directory): string {
  const parts = [
    dir.missing.size === 0 ? "" : `missing ${[...dir.missing].sort().join(", ")}`,
    dir.failed.size === 0 ? "" : `failed ${[...dir.failed].sort().join(", ")}`,
  ].filter((p) => p !== "");
  return parts.join("; ") || "Slack returned no name";
}

async function resolveWith(dir: Directory, list: SlackChannel[]): Promise<Resolved> {
  const channels: SlackChannel[] = [];
  const unknown: string[] = [];
  const unresolved: string[] = [];
  for (const c of list) {
    if (c.id !== "") {
      const name = (await dir.channel(c.id)).name ?? c.name;
      const byName = name === "" ? (await dir.idsByName())?.get(c.id.toLowerCase()) : undefined;
      if (name === "" && byName === undefined) unresolved.push(c.id);
      channels.push(byName === undefined ? { id: c.id, name } : { id: byName, name: c.id.toLowerCase() });
      continue;
    }
    const named = await dir.idsByName();
    const id = named?.get(c.name);
    if (named === null) unresolved.push(`#${c.name}`);
    else if (id === undefined) unknown.push(c.name);
    channels.push(id === undefined ? c : { id, name: c.name });
  }
  return { channels, unknown, unresolved, why: unresolved.length === 0 ? "" : lookupFailure(dir) };
}

export async function resolveChannels(sys: System, list: SlackChannel[]): Promise<Resolved> {
  const way = await findWay(sys, SLACK_KEY.source);
  if (way.kind === "missing") return { channels: list, unknown: [], unresolved: [], why: "" };
  return resolveWith(new Directory(sys, way, []), list);
}

function inChannels(list: SlackChannel[]): (m: Match) => boolean {
  return (m) =>
    m.channel !== undefined && list.some((c) => (c.id === "" ? c.name === m.channel?.name : c.id === m.channel?.id));
}

async function byline(dir: Directory, m: Match): Promise<{ author: string | null; avatar: string | null }> {
  if (!m.user) return { author: m.username ?? null, avatar: null };
  return { author: await dir.user(m.user), avatar: await dir.avatar(m.user) };
}

const TOKEN = /<([^<>]+)>/g;

async function token(dir: Directory, inner: string): Promise<string> {
  const [target = "", label] = inner.split("|", 2);
  if (target.startsWith("@")) return `@${label || (await dir.user(target.slice(1)))}`;
  if (target.startsWith("#")) return `#${label || (await dir.channel(target.slice(1))).name || target.slice(1)}`;
  if (target.startsWith("!subteam^")) return label || `@${await dir.group(target.slice("!subteam^".length))}`;
  if (target.startsWith("!")) return label || `@${target.slice(1).split("^")[0]}`;
  return label || target.replace(/^mailto:/, "");
}

async function readable(dir: Directory, text: string): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    parts.push(text.slice(last, m.index), await token(dir, m[1] ?? ""));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function inDm(c: Channel): boolean {
  return c.is_im === true || c.is_mpim === true || c.id.startsWith("D") || (c.name ?? "").startsWith("mpdm-");
}

function spot(m: Match): string {
  const where = messageOf(m.permalink);
  return where === null ? m.permalink : `${where.channel}/${where.ts}`;
}

async function threadReplies(dir: Directory, me: string, since: string, sent: Match[]): Promise<Match[]> {
  const threads = new Map<string, { where: Channel; ts: string; origin: string }>();
  for (const m of sent) {
    const thread = threadOf(m.permalink);
    if (thread === null || threads.size >= THREADS) continue;
    const where = m.channel ?? { id: thread.channel };
    if (inDm(where)) continue;
    threads.set(`${thread.channel}/${thread.ts}`, { where, ts: thread.ts, origin: new URL(m.permalink).origin });
  }
  const found: Match[] = [];
  for (const t of threads.values()) {
    for (const m of await dir.replies(t.where.id, t.ts, since)) {
      if (m.ts === t.ts || m.user === me || Number(m.ts) <= Number(since)) continue;
      const link = `${t.origin}/archives/${t.where.id}/p${m.ts.replace(".", "")}?thread_ts=${t.ts}&cid=${t.where.id}`;
      found.push({ ...m, channel: t.where, permalink: link });
    }
  }
  return found;
}

async function place(dir: Directory, me: string, c: Channel | undefined, fromMe: boolean): Promise<string> {
  if (c === undefined) return "";
  const full = c.is_im || c.is_mpim || !c.name ? await dir.channel(c.id, c) : c;
  if (full.is_im === true || c.id.startsWith("D")) {
    const other = full.user ?? (/^U[A-Z0-9]+$/.test(c.name ?? "") ? c.name : undefined);
    return fromMe && other !== undefined ? `DM @${await dir.user(other)}` : "DM";
  }
  if (full.is_mpim === true || full.name?.startsWith("mpdm-")) {
    const names = (full.name ?? "")
      .replace(/^mpdm-/, "")
      .replace(/-\d+$/, "")
      .split("--")
      .filter((n) => n !== "" && n !== me);
    return names.length === 0 ? "group DM" : `group DM ${names.map((n) => `@${n}`).join(", ")}`;
  }
  return full.name ? `#${full.name}` : "";
}

async function line(dir: Directory, me: string, myName: string, m: Match): Promise<string> {
  const where = await place(dir, myName, m.channel, m.user === me);
  const who = m.user === me ? "me" : m.user ? await dir.user(m.user) : (m.username ?? "someone");
  const attachments = m.attachments ?? [];
  const raw =
    m.text ||
    attachments
      .flatMap((a) => [a.title, a.pretext, a.text, a.fallback])
      .find((t) => t !== undefined && t.trim() !== "") ||
    blockText([m.blocks, attachments.map((a) => a.blocks)]);
  const text = (await readable(dir, raw)).replaceAll("\n", " ").trim();
  return cut(`${where ? `${where} · ` : ""}${who}: ${text || "(no text)"}`, 200);
}

function blockText(node: unknown): string {
  return blockParts(node).join(" ").replace(/\s+/g, " ").trim();
}

function blockParts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(blockParts);
  if (node === null || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const own = typeof o.text === "string" ? [o.text] : blockParts(o.text);
  return [...own, ...blockParts(o.elements), ...blockParts(o.fields)];
}

async function full(dir: Directory, m: Match): Promise<string | undefined> {
  const parts = [m.text, ...(m.attachments ?? []).flatMap((a) => [a.pretext, a.title, a.text])];
  const said = [...new Set(parts.filter((p) => p !== undefined && p.trim() !== ""))].join("\n\n");
  const raw = said || m.attachments?.[0]?.fallback || blockText([m.blocks, m.attachments?.map((a) => a.blocks)]);
  return raw === "" ? undefined : clip(await readable(dir, raw), MAX_BODY);
}

async function search(sys: System, way: Way, query: string): Promise<Match[]> {
  const r = await slackGet<Answer & { messages?: { matches: Match[] } }>(sys, way, "search.messages", {
    query,
    sort: "timestamp",
    sort_dir: "desc",
    count: "100",
  });
  return r.messages?.matches ?? [];
}

function reactionState(reactions: Reaction[], me: string): { state: string; done: boolean } | null {
  const mine = reactions.filter((r) => r.users.includes(me));
  if (mine.length === 0) return null;
  const done = mine.some((r) => DONE_REACTIONS.has(r.name));
  return { state: `reacted ${mine.map((r) => `:${r.name}:`).join(" ")}`, done };
}

async function fetchSlack(sys: System, ctx: Ctx, cursor: string | null): Promise<Fetched> {
  const way = await keyWay(sys, SLACK_KEY);
  const auth = await slackGet<Answer & { user_id: string; user?: string }>(sys, way, "auth.test", {});
  const me = auth.user_id;
  const dir = new Directory(sys, way, []);
  const lists = {} as Record<SlackChannelKey, SlackChannel[]>;
  const unknown: string[] = [];
  for (const key of SLACK_CHANNEL_KEYS) {
    const r = await resolveWith(dir, ctx.config[key]);
    lists[key] = r.channels;
    unknown.push(...r.unknown.map((name) => `#${name} (${key})`));
  }
  const ignored = inChannels(lists.slackIgnoreChannels);
  const kept = (m: Match) => !ignored(m);
  const since = cursor ?? String(Math.floor(ctx.now.getTime() / 1000) - FIRST_LOOK_S);
  const day = (s: number) => new Date((s - DAY_S) * 1000).toISOString().slice(0, 10);
  const after = day(Number(since));
  const threadsAfter = day(Math.min(Number(since), Math.floor(ctx.now.getTime() / 1000) - THREAD_LOOK_S));
  const newer = (m: Match) => Number(m.ts) > Number(since);
  const mentions = (await search(sys, way, `<@${me}> after:${after}`)).filter(newer).filter(kept);
  const recent = await search(sys, way, `from:<@${me}> after:${threadsAfter}`);
  const sent = recent.filter(newer).filter(kept);
  const dms = (await search(sys, way, `to:<@${me}> after:${after}`)).filter(
    (m) => newer(m) && m.user !== me && m.channel !== undefined && inDm(m.channel),
  );
  const alerts: Match[] = [];
  for (const c of lists.slackAlertChannels) {
    if (c.name === "") continue;
    const found = await search(sys, way, `in:#${c.name} after:${after}`);
    alerts.push(...found.filter((m) => newer(m) && m.user !== me && kept(m)));
  }
  dir.learn([...mentions, ...recent, ...dms, ...alerts]);
  const pinged: [Match, string][] = mentions.map((m) => [m, "mention"]);
  for (const g of await dir.groupsOf(me)) {
    const found = (await search(sys, way, `<!subteam^${g.id}> after:${after}`)).filter(newer).filter(kept);
    dir.learn(found);
    pinged.push(...found.map((m): [Match, string] => [m, `mention @${g.handle}`]));
  }
  const myName = auth.user ?? me;
  const inThreads = await threadReplies(dir, me, since, recent.filter(kept));
  let newest = Number(since);
  for (const m of [...pinged.map(([m]) => m), ...sent, ...dms, ...alerts, ...inThreads])
    newest = Math.max(newest, Number(m.ts));

  const out: Record<string, unknown>[] = [];
  const held = new Set<string>();
  const seen = new Set(alerts.map(spot));
  for (const m of alerts) {
    out.push({
      source: "slack",
      kind: "alert",
      url: m.permalink,
      title: await line(dir, me, myName, m),
      body: await full(dir, m),
      ...(await byline(dir, m)),
      state: "alert",
      needs_me: true,
    });
  }
  for (const [m, state] of pinged) {
    if (m.user === me || seen.has(spot(m))) continue;
    const app = m.channel !== undefined && inDm(m.channel) ? await dir.fromApp(m) : false;
    if (app === null) held.add(spot(m));
    if (app !== false) continue;
    seen.add(spot(m));
    out.push({
      source: "slack",
      kind: "message",
      url: m.permalink,
      title: await line(dir, me, myName, m),
      body: await full(dir, m),
      ...(await byline(dir, m)),
      state,
      needs_me: true,
    });
  }
  const fromPeople: Match[] = [];
  for (const m of dms) {
    const app = await dir.fromApp(m);
    if (app === null) held.add(spot(m));
    if (app === false) fromPeople.push(m);
  }
  for (const [m, state] of [
    ...fromPeople.map((d) => [d, "dm"] as const),
    ...inThreads.map((r) => [r, "reply"] as const),
  ]) {
    if (seen.has(spot(m))) continue;
    seen.add(spot(m));
    out.push({
      source: "slack",
      kind: "message",
      url: m.permalink,
      title: await line(dir, me, myName, m),
      body: await full(dir, m),
      ...(await byline(dir, m)),
      state,
      needs_me: true,
    });
  }
  for (const m of sent) {
    out.push({
      source: "slack",
      kind: "message",
      url: m.permalink,
      title: await line(dir, me, myName, m),
      author: "me",
      state: "sent",
      needs_me: false,
    });
  }

  const open = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE source = 'slack' AND kind IN ('message', 'alert') AND needs_me = 1 AND closed_at IS NULL
       AND ignored IS NULL ORDER BY first_seen DESC LIMIT ?`,
    RECHECK,
  );
  const toCheck = new Map<string, Record<string, unknown>>();
  for (const i of open) if (i.url) toCheck.set(i.url, { source: "slack", kind: i.kind, url: i.url });
  for (const item of out) if (item.needs_me === true) toCheck.set(item.url as string, item);
  for (const [url, item] of toCheck) {
    const at = messageOf(url);
    if (at === null) continue;
    const got = await dir.reactions(at.channel, at.ts);
    if (got === null && dir.missing.has("reactions:read")) break;
    const reacted = got === null ? null : reactionState(got.reactions, me);
    if (reacted === null) continue;
    if (!out.includes(item)) out.push(item);
    item.state = reacted.state;
    item.needs_me = !reacted.done;
  }
  const replies = recent.flatMap((m) => {
    const thread = threadOf(m.permalink);
    const dm = m.channel !== undefined && inDm(m.channel);
    return thread === null ? [] : [{ ...thread, at: Number(m.ts), dm }];
  });
  for (const [url, item] of toCheck) {
    if (item.needs_me === false || item.kind === "alert") continue;
    const thread = threadOf(url);
    const at = messageOf(url);
    if (thread === null || at === null) continue;
    const replied = replies.some(
      (r) => r.channel === thread.channel && r.at > Number(at.ts) && (r.dm || r.ts === thread.ts),
    );
    if (!replied) continue;
    if (!out.includes(item)) out.push(item);
    item.state = "replied";
    item.needs_me = false;
  }

  const answered: string[] = [];
  const waits = all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE closed_at IS NULL");
  for (const w of waits) {
    const thread = threadOf(w.url);
    if (thread === null) continue;
    const askedAt = String(Date.parse(w.asked_at) / 1000);
    const r = await slackGet<Answer & { messages: Match[] }>(sys, way, "conversations.replies", {
      channel: thread.channel,
      ts: thread.ts,
      oldest: askedAt,
      limit: "100",
    });
    const reply = r.messages.find((m) => m.user !== me && Number(m.ts) > Number(askedAt) && m.ts !== thread.ts);
    let title: string | null = null;
    let body: string | undefined;
    if (reply !== undefined) {
      body = await full(dir, reply);
      title = `${w.who} answered: ${(body ?? "").replaceAll("\n", " ")}`;
    } else {
      const asked = messageOf(w.url);
      const got = asked === null ? null : await dir.reactions(asked.channel, asked.ts);
      const mine = got !== null && got.user === me;
      const theirs = mine ? got.reactions.find((x) => x.users.some((u) => u !== me)) : undefined;
      const by = theirs?.users.find((u) => u !== me);
      if (theirs !== undefined && by !== undefined) title = `${await dir.user(by)} reacted :${theirs.name}:`;
    }
    if (title === null) continue;
    answered.push(w.url);
    out.push({
      source: "slack",
      kind: "thread",
      url: w.url,
      title: cut(title, 200),
      body,
      author: w.who,
      ticket: w.ticket_id,
      state: "answered",
      needs_me: true,
    });
  }
  const notes = [
    dir.missing.size === 0
      ? ""
      : `missing ${[...dir.missing].sort().join(", ")}: names, DMs, group mentions or reactions are left out`,
    dir.failed.size === 0 ? "" : `failed ${[...dir.failed].sort().join(", ")}`,
    held.size === 0 ? "" : `${held.size} DMs from unchecked senders wait for the next sync`,
    unknown.length === 0 ? "" : `no channel ${unknown.join(", ")}`,
  ].filter((n) => n !== "");
  const next = held.size === 0 ? newest.toFixed(6) : since;
  return {
    items: out,
    cursor: next,
    answered,
    warning: notes.length === 0 ? null : notes.join("; "),
    channels: [...lists.slackAlertChannels, ...lists.slackIgnoreChannels],
  };
}

export const slack: Fetcher = {
  name: "slack",
  key: SLACK_KEY,
  check: (sys) => keyCheck(sys, SLACK_KEY),
  fetch: fetchSlack,
};
