import type { Ctx } from "../commands.ts";
import { all, type WaitRow } from "../db.ts";
import type { Fetched, Fetcher } from "../fetch.ts";
import { type KeySpec, keyedCall, type System, type Way } from "../keys.ts";
import { cut, HubError } from "../util.ts";
import { keyCheck, keyWay } from "./keyed.ts";

const FIRST_LOOK_S = 2 * 86_400;
const DAY_S = 86_400;

export const SLACK_KEY: KeySpec = {
  source: "slack",
  host: "slack.com",
  header: "Authorization: Bearer {key}",
  allow: ["GET /api/auth.test", "GET /api/search.messages", "GET /api/conversations.replies"],
};

type Match = {
  ts: string;
  text: string;
  permalink: string;
  user?: string;
  username?: string;
  channel?: { id: string; name?: string };
};
type Answer = { ok: boolean; error?: string };

async function slackGet<T extends Answer>(
  sys: System,
  way: Way,
  method: string,
  args: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(args).toString();
  const text = await keyedCall(sys, way, SLACK_KEY, "GET", `/api/${method}${query ? `?${query}` : ""}`);
  const answer = JSON.parse(text) as T;
  if (!answer.ok) throw new HubError(`slack ${method}: ${answer.error ?? "not ok"}`);
  return answer;
}

export function threadOf(url: string): { channel: string; ts: string } | null {
  const m = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/.exec(url);
  if (m === null) return null;
  const thread = new URLSearchParams(m[4] ?? "").get("thread_ts");
  return { channel: m[1] as string, ts: thread ?? `${m[2]}.${m[3]}` };
}

function line(m: Match): string {
  const where = m.channel?.name ? `#${m.channel.name} ` : "";
  return cut(`${where}${m.username ?? m.user ?? "someone"}: ${m.text.replaceAll("\n", " ")}`, 200);
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

async function fetchSlack(sys: System, ctx: Ctx, cursor: string | null): Promise<Fetched> {
  const way = await keyWay(sys, SLACK_KEY);
  const me = (await slackGet<Answer & { user_id: string }>(sys, way, "auth.test", {})).user_id;
  const since = cursor ?? String(Math.floor(ctx.now.getTime() / 1000) - FIRST_LOOK_S);
  const after = new Date((Number(since) - DAY_S) * 1000).toISOString().slice(0, 10);
  const newer = (m: Match) => Number(m.ts) > Number(since);
  let newest = Number(since);
  const seen = (m: Match) => {
    newest = Math.max(newest, Number(m.ts));
  };
  const out: unknown[] = [];
  for (const m of (await search(sys, way, `<@${me}> after:${after}`)).filter(newer)) {
    seen(m);
    if (m.user === me) continue;
    out.push({
      source: "slack",
      kind: "message",
      url: m.permalink,
      title: line(m),
      author: m.username ?? m.user,
      state: "mention",
      needs_me: true,
    });
  }
  for (const m of (await search(sys, way, `from:<@${me}> after:${after}`)).filter(newer)) {
    seen(m);
    out.push({
      source: "slack",
      kind: "message",
      url: m.permalink,
      title: line(m),
      author: "me",
      state: "sent",
      needs_me: false,
    });
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
    if (reply === undefined) continue;
    answered.push(w.url);
    out.push({
      source: "slack",
      kind: "thread",
      url: w.url,
      title: cut(`${w.who} answered: ${reply.text.replaceAll("\n", " ")}`, 200),
      author: w.who,
      ticket: w.ticket_id,
      state: "answered",
      needs_me: true,
    });
  }
  return { items: out, cursor: newest.toFixed(6), answered };
}

export const slack: Fetcher = {
  name: "slack",
  key: SLACK_KEY,
  check: (sys) => keyCheck(sys, SLACK_KEY),
  fetch: fetchSlack,
};
