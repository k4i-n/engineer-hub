import type { Ctx } from "../commands.ts";
import { all, one, type WaitRow } from "../db.ts";
import type { Fetched, Fetcher } from "../fetch.ts";
import { type KeySpec, keyedCall, type System } from "../keys.ts";
import { clip, cut, HubError } from "../util.ts";
import { keyCheck, keyWay } from "./keyed.ts";

const FIRST_LOOK_MS = 2 * 86_400_000;
const CLOSED_STATES = ["completed", "canceled"];
const MAX_BODY = 4000;

export const LINEAR_KEY: KeySpec = {
  source: "linear",
  host: "api.linear.app",
  header: "Authorization: {key}",
  allow: ["POST /graphql"],
};

const LINEAR_ID = /^([A-Z][A-Z0-9]*)-(\d+)$/;

const QUERY = `query($since: DateTimeOrDuration!, $comments: CommentFilter!) {
  issues(filter: { assignee: { isMe: { eq: true } }, updatedAt: { gt: $since } }, first: 50) {
    nodes { identifier title description url updatedAt priorityLabel assignee { name } state { name type } }
  }
  notifications(filter: { createdAt: { gt: $since } }, first: 50) {
    nodes {
      type createdAt
      ... on IssueNotification { issue { identifier title url } comment { url body } actor { name } }
    }
  }
  comments(filter: $comments, first: 50) {
    nodes { url body createdAt user { name } issue { identifier title url } parent { url } }
  }
}`;

type Issue = {
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  updatedAt?: string;
  priorityLabel?: string;
  assignee?: { name: string } | null;
  state?: { name: string; type: string };
};
type Note = {
  type: string;
  createdAt: string;
  issue?: Issue;
  comment?: { url: string; body: string } | null;
  actor?: { name: string } | null;
};
type Comment = {
  url: string;
  body: string;
  createdAt?: string;
  user?: { name: string } | null;
  issue?: Issue | null;
  parent?: { url: string } | null;
};
type Answer = {
  data?: { issues: { nodes: Issue[] }; notifications: { nodes: Note[] }; comments: { nodes: Comment[] } } | null;
  errors?: { message: string }[];
};

function body(text: string | null | undefined): string | undefined {
  const trimmed = (text ?? "").trim();
  return trimmed === "" ? undefined : clip(trimmed, MAX_BODY);
}

function hasTicket(ctx: Ctx, id: string): boolean {
  return one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id) !== undefined;
}

function ticketIssues(ctx: Ctx): object[] {
  const byTeam = new Map<string, number[]>();
  for (const { id } of all<{ id: string }>(ctx.db, "SELECT id FROM ticket")) {
    if (ctx.config.localIdPrefixes.some((p) => id.startsWith(p))) continue;
    const [, team, number] = LINEAR_ID.exec(id) ?? [];
    if (team === undefined || number === undefined) continue;
    byTeam.set(team, [...(byTeam.get(team) ?? []), Number(number)]);
  }
  return [...byTeam].map(([key, numbers]) => ({ team: { key: { eq: key } }, number: { in: numbers } }));
}

function commentId(url: string | undefined): string | null {
  return /linear\.app\/.*#comment-([\w-]+)$/.exec(url ?? "")?.[1] ?? null;
}

function isWho(name: string, who: string): boolean {
  const n = name.toLowerCase();
  const w = who.toLowerCase().replace(/^@/, "");
  return n.includes(w) || w.includes(n.split(" ")[0] ?? n);
}

function trackedThreads(ctx: Ctx): Map<string, WaitRow> {
  const waits = all<WaitRow>(ctx.db, "SELECT * FROM wait WHERE closed_at IS NULL AND url LIKE '%linear.app/%'");
  return new Map(waits.flatMap((w) => (commentId(w.url) === null ? [] : [[commentId(w.url) as string, w]])));
}

function threadReply(w: WaitRow, c: Comment): Record<string, unknown> {
  const who = c.user?.name ?? "someone";
  const said = isWho(who, w.who) ? "answered" : "replied";
  return {
    source: "linear",
    kind: "thread",
    url: w.url,
    title: cut(`${who} ${said}: ${c.body.replaceAll("\n", " ")}`, 200),
    body: body(c.body),
    author: who,
    ticket: w.ticket_id,
    state: said,
    needs_me: true,
  };
}

async function fetchLinear(sys: System, ctx: Ctx, cursor: string | null): Promise<Fetched> {
  const started = ctx.now.toISOString();
  const since = cursor ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS).toISOString();
  const way = await keyWay(sys, LINEAR_KEY);
  const comments = {
    createdAt: { gt: since },
    user: { isMe: { eq: false } },
    issue: { or: [{ assignee: { isMe: { eq: true } } }, ...ticketIssues(ctx)] },
  };
  const text = await keyedCall(sys, way, LINEAR_KEY, "POST", "/graphql", {
    query: QUERY,
    variables: { since, comments },
  });
  const answer = JSON.parse(text) as Answer;
  if (answer.data == null) throw new HubError(`linear: ${answer.errors?.[0]?.message ?? "no data"}`);
  const out: unknown[] = answer.data.issues.nodes.map((i) => {
    const closed = CLOSED_STATES.includes(i.state?.type ?? "");
    return {
      source: "linear",
      kind: "issue",
      url: i.url,
      title: `${i.identifier} ${i.title}`,
      body: body(i.description),
      state: i.state?.name,
      needs_me: !closed && !hasTicket(ctx, i.identifier),
    };
  });
  for (const n of answer.data.notifications.nodes) {
    if (!/mention/i.test(n.type) || n.issue === undefined) continue;
    const said = n.comment?.body ? `: ${cut(n.comment.body.replaceAll("\n", " "), 160)}` : "";
    out.push({
      source: "linear",
      kind: "message",
      ref: n.comment?.url ?? `${n.issue.url}#mention-${n.createdAt}`,
      url: n.comment?.url ?? n.issue.url,
      title: `${n.issue.identifier} ${n.actor?.name ?? "someone"} mentioned you${said}`,
      body: body(n.comment?.body),
      author: n.actor?.name,
      state: "mention",
      needs_me: true,
    });
  }
  const mentioned = new Set(answer.data.notifications.nodes.map((n) => n.comment?.url));
  const tracked = trackedThreads(ctx);
  const latest = new Map<WaitRow, Comment>();
  const folded = new Set<string>();
  for (const c of answer.data.comments.nodes) {
    const w = tracked.get(commentId(c.parent?.url) ?? "");
    if (w === undefined || (c.createdAt ?? "") <= (w.reopened_at ?? w.asked_at)) continue;
    folded.add(c.url);
    const seen = latest.get(w);
    if (seen === undefined || (seen.createdAt ?? "") < (c.createdAt ?? "")) latest.set(w, c);
  }
  const replies = [...latest].map(([w, c]) => threadReply(w, c));
  for (const c of answer.data.comments.nodes) {
    if (c.issue == null || mentioned.has(c.url) || folded.has(c.url)) continue;
    const slack = SLACK_SYNC.exec(c.body)?.[1];
    if (slack !== undefined) {
      out.push({ source: "slack", kind: "thread", url: slack, title: `${c.issue.identifier} ${c.issue.title}` });
      continue;
    }
    const who = c.user?.name ?? "someone";
    out.push({
      source: "linear",
      kind: "message",
      ref: c.url,
      url: c.url,
      title: `${c.issue.identifier} ${who} commented: ${cut(c.body.replaceAll("\n", " "), 160)}`,
      body: body(c.body),
      author: who,
      state: "comment",
      needs_me: true,
    });
  }
  const tracker = answer.data.issues.nodes
    .filter((i) => hasTicket(ctx, i.identifier))
    .map((i) => ({
      id: i.identifier,
      title: i.title,
      state: i.state?.name ?? null,
      priority: i.priorityLabel === undefined || i.priorityLabel === "No priority" ? null : i.priorityLabel,
      assignee: i.assignee?.name ?? null,
      url: i.url,
      updated: i.updatedAt ?? null,
    }));
  const items = [...out.filter((i) => !folded.has((i as { ref?: string }).ref ?? "")), ...replies];
  const answered = replies.filter((r) => r.state === "answered").map((r) => r.url as string);
  return { items, cursor: started, tracker, answered };
}

const SLACK_SYNC = /^This comment thread is synced to a corresponding \[thread in Slack\]\((https:\/\/[^)\s]+)\)/;

export const linear: Fetcher = {
  name: "linear",
  key: LINEAR_KEY,
  check: (sys) => keyCheck(sys, LINEAR_KEY),
  fetch: fetchLinear,
};
