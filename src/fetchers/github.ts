import type { Ctx } from "../commands.ts";
import { all, type ItemRow } from "../db.ts";
import type { Check, Fetched, Fetcher } from "../fetch.ts";
import { lastLine, type System } from "../keys.ts";
import { HubError } from "../util.ts";

const FIRST_LOOK_MS = 2 * 86_400_000;

const QUERY = `query($requested: String!, $mine: String!) {
  requested: search(query: $requested, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { url title author { login } } }
  }
  mine: search(query: $mine, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        url title state merged reviewDecision author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

type Pr = {
  url?: string;
  title?: string;
  author?: { login: string } | null;
  state?: string;
  merged?: boolean;
  reviewDecision?: string | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Answer = { data?: { requested: { nodes: Pr[] }; mine: { nodes: Pr[] } }; errors?: { message: string }[] };

export function prState(pr: Pr): { state: string; needsMe: boolean } {
  if (pr.merged) return { state: "merged", needsMe: false };
  if (pr.state === "CLOSED") return { state: "closed", needsMe: false };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { state: "changes requested", needsMe: true };
  const checks = pr.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  if (checks === "FAILURE" || checks === "ERROR") return { state: "checks failing", needsMe: true };
  if (pr.reviewDecision === "APPROVED") return { state: "approved", needsMe: true };
  return { state: "open", needsMe: false };
}

async function check(sys: System): Promise<Check> {
  const r = await sys.run("gh", ["auth", "status", "--hostname", "github.com"]);
  if (r.code === 127) return { ok: false, how: "gh is not installed", fix: ["brew install gh", "gh auth login"] };
  if (r.code !== 0) return { ok: false, how: "gh is signed out", fix: ["gh auth login"] };
  return { ok: true, how: "gh, signed in", fix: [] };
}

async function fetchGithub(sys: System, ctx: Ctx, cursor: string | null): Promise<Fetched> {
  const started = ctx.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const since = cursor ?? new Date(ctx.now.getTime() - FIRST_LOOK_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const r = await sys.run("gh", [
    "api",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-f",
    "requested=is:pr is:open review-requested:@me archived:false",
    "-f",
    `mine=is:pr author:@me updated:>=${since}`,
  ]);
  if (r.code !== 0) throw new HubError(`gh api graphql: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  const answer = JSON.parse(r.stdout) as Answer;
  if (answer.data === undefined) throw new HubError(`github: ${answer.errors?.[0]?.message ?? "no data"}`);
  const requested = answer.data.requested.nodes.filter((pr) => pr.url !== undefined);
  const out: unknown[] = requested.map((pr) => ({
    source: "github",
    kind: "review_request",
    url: pr.url,
    title: pr.title,
    author: pr.author?.login,
    state: "open",
    needs_me: true,
  }));
  const open = new Set(requested.map((pr) => pr.url));
  const tracked = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE source = 'github' AND kind = 'review_request' AND state = 'open'",
  );
  for (const i of tracked) {
    if (!open.has(i.ref))
      out.push({ source: "github", kind: "review_request", ref: i.ref, state: "done", needs_me: false });
  }
  for (const pr of answer.data.mine.nodes) {
    if (pr.url === undefined) continue;
    const s = prState(pr);
    out.push({
      source: "github",
      kind: "pr",
      url: pr.url,
      title: pr.title,
      author: pr.author?.login,
      state: s.state,
      needs_me: s.needsMe,
    });
  }
  return { items: out, cursor: started };
}

export const github: Fetcher = { name: "github", key: null, check, fetch: fetchGithub };
