import type { Ctx } from "../commands.ts";
import { all, type ItemRow, type WaitRow } from "../db.ts";
import type { Fetched, Fetcher } from "../fetch.ts";
import { type KeySpec, keyedCall, type System, type Way } from "../keys.ts";
import { cut, HubError } from "../util.ts";
import { keyCheck, keyWay } from "./keyed.ts";

const FIRST_LOOK_S = 2 * 86_400;
const DAY_S = 86_400;
const DONE_REACTIONS = new Set(["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "done"]);
const RECHECK = 30;
const NO_SCOPE = new Set(["missing_scope", "no_permission", "not_allowed_token_type"]);

export const SLACK_KEY: KeySpec = {
  source: "slack",
  host: "slack.com",
  header: "Authorization: Bearer {key}",
  allow: [
    "GET /api/auth.test",
    "GET /api/search.messages",
    "GET /api/conversations.replies",
    "GET /api/conversations.info",
    "GET /api/users.info",
    "GET /api/usergroups.list",
    "GET /api/reactions.get",
  ],
};

type Channel = { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string };
type Match = {
  ts: string;
  text: string;
  permalink: string;
  user?: string;
  username?: string;
  channel?: Channel;
};
type Reaction = { name: string; users: string[] };
type User = { id: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
type Group = { id: string; handle: string };
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

class Directory {
  readonly missing = new Set<string>();
  private readonly users = new Map<string, string | null>();
  private readonly channels = new Map<string, Channel | null>();
  private groups: Map<string, string> | null = null;
  private readonly sys: System;
  private readonly way: Way;

  constructor(sys: System, way: Way, known: Match[]) {
    this.sys = sys;
    this.way = way;
    for (const m of known) if (m.user && m.username) this.users.set(m.user, m.username);
  }

  private async soft<T extends Answer>(method: string, args: Record<string, string>, scope: string): Promise<T | null> {
    try {
      return await slackGet<T>(this.sys, this.way, method, args);
    } catch (error) {
      if (!(error instanceof SlackError) || NO_SCOPE.has(error.code)) {
        this.missing.add(error instanceof SlackError ? (error.needed ?? scope) : scope);
      }
      return null;
    }
  }

  async user(id: string): Promise<string> {
    if (!this.users.has(id) || this.users.get(id) === null) {
      const r = await this.soft<Answer & { user: User }>("users.info", { user: id }, "users:read");
      const u = r?.user;
      const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || null;
      this.users.set(id, name ?? this.users.get(id) ?? null);
    }
    return this.users.get(id) ?? id;
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

  async group(id: string): Promise<string> {
    if (this.groups === null) {
      const r = await this.soft<Answer & { usergroups: Group[] }>("usergroups.list", {}, "usergroups:read");
      this.groups = new Map((r?.usergroups ?? []).map((g) => [g.id, g.handle]));
    }
    return this.groups.get(id) ?? id;
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
  const text = (await readable(dir, m.text)).replaceAll("\n", " ");
  return cut(`${where ? `${where} · ` : ""}${who}: ${text}`, 200);
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
  const since = cursor ?? String(Math.floor(ctx.now.getTime() / 1000) - FIRST_LOOK_S);
  const after = new Date((Number(since) - DAY_S) * 1000).toISOString().slice(0, 10);
  const newer = (m: Match) => Number(m.ts) > Number(since);
  const mentions = (await search(sys, way, `<@${me}> after:${after}`)).filter(newer);
  const sent = (await search(sys, way, `from:<@${me}> after:${after}`)).filter(newer);
  const dir = new Directory(sys, way, [...mentions, ...sent]);
  const myName = auth.user ?? me;
  let newest = Number(since);
  for (const m of [...mentions, ...sent]) newest = Math.max(newest, Number(m.ts));

  const out: Record<string, unknown>[] = [];
  for (const m of mentions) {
    if (m.user === me) continue;
    out.push({
      source: "slack",
      kind: "message",
      url: m.permalink,
      title: await line(dir, me, myName, m),
      author: m.user ? await dir.user(m.user) : m.username,
      state: "mention",
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
    `SELECT * FROM item WHERE source = 'slack' AND kind = 'message' AND needs_me = 1 AND closed_at IS NULL
       AND ignored IS NULL ORDER BY first_seen DESC LIMIT ?`,
    RECHECK,
  );
  const toCheck = new Map<string, Record<string, unknown>>();
  for (const i of open) if (i.url) toCheck.set(i.url, { source: "slack", kind: "message", url: i.url });
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
  const replies = sent.flatMap((m) => {
    const thread = threadOf(m.permalink);
    return thread === null ? [] : [{ ...thread, at: Number(m.ts) }];
  });
  for (const [url, item] of toCheck) {
    if (item.needs_me === false) continue;
    const thread = threadOf(url);
    const at = messageOf(url);
    if (thread === null || at === null) continue;
    const replied = replies.some((r) => r.channel === thread.channel && r.ts === thread.ts && r.at > Number(at.ts));
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
    if (reply !== undefined) {
      title = `${w.who} answered: ${(await readable(dir, reply.text)).replaceAll("\n", " ")}`;
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
      author: w.who,
      ticket: w.ticket_id,
      state: "answered",
      needs_me: true,
    });
  }
  const warning =
    dir.missing.size === 0
      ? null
      : `missing ${[...dir.missing].sort().join(", ")}: names, DMs or reactions are left out`;
  return { items: out, cursor: newest.toFixed(6), answered, warning };
}

export const slack: Fetcher = {
  name: "slack",
  key: SLACK_KEY,
  check: (sys) => keyCheck(sys, SLACK_KEY),
  fetch: fetchSlack,
};
