import type { Ctx } from "../commands.ts";
import { all, one } from "../db.ts";
import type { Fetched, Fetcher } from "../fetch.ts";
import { type KeySpec, keyedCall, type System } from "../keys.ts";
import { cut, HubError } from "../util.ts";
import { keyCheck, keyWay } from "./keyed.ts";

const FIRST_LOOK_MS = 2 * 86_400_000;
const CLOSED_STATES = ["completed", "canceled"];

export const LINEAR_KEY: KeySpec = {
  source: "linear",
  host: "api.linear.app",
  header: "Authorization: {key}",
  allow: ["POST /graphql"],
};

const QUERY = `query($since: DateTimeOrDuration!, $tickets: [ID!]!) {
  issues(filter: { assignee: { isMe: { eq: true } }, updatedAt: { gt: $since } }, first: 50) {
    nodes { identifier title url updatedAt priorityLabel assignee { name } state { name type } }
  }
  notifications(filter: { createdAt: { gt: $since } }, first: 50) {
    nodes {
      type createdAt
      ... on IssueNotification { issue { identifier title url } comment { url body } actor { name } }
    }
  }
  comments(
    filter: {
      createdAt: { gt: $since }
      user: { isMe: { eq: false } }
      issue: { or: [{ assignee: { isMe: { eq: true } } }, { id: { in: $tickets } }] }
    }
    first: 50
  ) {
    nodes { url body user { name } issue { identifier title url } }
  }
}`;

type Issue = {
  identifier: string;
  title: string;
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
type Comment = { url: string; body: string; user?: { name: string } | null; issue?: Issue | null };
type Answer = {
  data?: { issues: { nodes: Issue[] }; notifications: { nodes: Note[] }; comments: { nodes: Comment[] } } | null;
  errors?: { message: string }[];
};

function hasTicket(ctx: Ctx, id: string): boolean {
  return one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id) !== undefined;
}

async function fetchLinear(sys: System, ctx: Ctx, cursor: string | null): Promise<Fetched> {
  const started = ctx.now.toISOString();
  const since = cursor ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS).toISOString();
  const way = await keyWay(sys, LINEAR_KEY);
  const tickets = all<{ id: string }>(ctx.db, "SELECT id FROM ticket").map((t) => t.id);
  const text = await keyedCall(sys, way, LINEAR_KEY, "POST", "/graphql", {
    query: QUERY,
    variables: { since, tickets },
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
      author: n.actor?.name,
      state: "mention",
      needs_me: true,
    });
  }
  const mentioned = new Set(answer.data.notifications.nodes.map((n) => n.comment?.url));
  for (const c of answer.data.comments.nodes) {
    if (c.issue == null || mentioned.has(c.url)) continue;
    const who = c.user?.name ?? "someone";
    out.push({
      source: "linear",
      kind: "message",
      ref: c.url,
      url: c.url,
      title: `${c.issue.identifier} ${who} commented: ${cut(c.body.replaceAll("\n", " "), 160)}`,
      author: who,
      state: "comment",
      needs_me: true,
    });
  }
  const tracker = answer.data.issues.nodes
    .filter((i) => hasTicket(ctx, i.identifier))
    .map((i) => ({
      id: i.identifier,
      state: i.state?.name ?? null,
      priority: i.priorityLabel === undefined || i.priorityLabel === "No priority" ? null : i.priorityLabel,
      assignee: i.assignee?.name ?? null,
      url: i.url,
      updated: i.updatedAt ?? null,
    }));
  return { items: out, cursor: started, tracker };
}

export const linear: Fetcher = {
  name: "linear",
  key: LINEAR_KEY,
  check: (sys) => keyCheck(sys, LINEAR_KEY),
  fetch: fetchLinear,
};
