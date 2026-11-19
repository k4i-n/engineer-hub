import type { Ctx } from "../commands.ts";
import { one } from "../db.ts";
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

const QUERY = `query($since: DateTimeOrDuration!) {
  issues(filter: { assignee: { isMe: { eq: true } }, updatedAt: { gt: $since } }, first: 50) {
    nodes { identifier title url state { name type } }
  }
  notifications(filter: { createdAt: { gt: $since } }, first: 50) {
    nodes {
      type createdAt
      ... on IssueNotification { issue { identifier title url } comment { url body } actor { name } }
    }
  }
}`;

type Issue = { identifier: string; title: string; url: string; state?: { name: string; type: string } };
type Note = {
  type: string;
  createdAt: string;
  issue?: Issue;
  comment?: { url: string; body: string } | null;
  actor?: { name: string } | null;
};
type Answer = {
  data?: { issues: { nodes: Issue[] }; notifications: { nodes: Note[] } };
  errors?: { message: string }[];
};

function hasTicket(ctx: Ctx, id: string): boolean {
  return one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id) !== undefined;
}

async function fetchLinear(sys: System, ctx: Ctx, cursor: string | null): Promise<Fetched> {
  const started = ctx.now.toISOString();
  const since = cursor ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS).toISOString();
  const way = await keyWay(sys, LINEAR_KEY);
  const text = await keyedCall(sys, way, LINEAR_KEY, "POST", "/graphql", { query: QUERY, variables: { since } });
  const answer = JSON.parse(text) as Answer;
  if (answer.data === undefined) throw new HubError(`linear: ${answer.errors?.[0]?.message ?? "no data"}`);
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
  return { items: out, cursor: started };
}

export const linear: Fetcher = {
  name: "linear",
  key: LINEAR_KEY,
  check: (sys) => keyCheck(sys, LINEAR_KEY),
  fetch: fetchLinear,
};
