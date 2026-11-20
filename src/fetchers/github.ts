import type { Ctx } from "../commands.ts";
import { all, type ItemRow } from "../db.ts";
import type { Check, Fetched, Fetcher } from "../fetch.ts";
import { lastLine, type System } from "../keys.ts";
import { HubError } from "../util.ts";

const FIRST_LOOK_MS = 2 * 86_400_000;
const MAX_BODY = 4000;
const LOOKUP_BATCH = 50;

const PR_FIELDS = `url title headRefName body state merged isDraft reviewDecision viewerDidAuthor author { login }
        latestReviews(first: 20) { nodes { state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const SEARCH = `query($requested: String!, $mine: String!) {
  requested: search(query: $requested, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { url title headRefName body author { login } } }
  }
  mine: search(query: $mine, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

function lookup(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$p${i}: URI!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `  p${i}: resource(url: $p${i}) { ... on PullRequest { ${PR_FIELDS} } }`,
  ).join("\n");
  return `query(${vars}) {\n${fields}\n}`;
}

type Pr = {
  url?: string;
  title?: string;
  headRefName?: string;
  body?: string;
  author?: { login: string } | null;
  state?: string;
  merged?: boolean;
  isDraft?: boolean;
  viewerDidAuthor?: boolean;
  reviewDecision?: string | null;
  latestReviews?: { nodes: { state: string }[] };
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};
type Searched = { requested: { nodes: Pr[] }; mine: { nodes: Pr[] } };
type Answer<T> = { data?: T; errors?: { message: string }[] };

async function graphql<T>(sys: System, fields: string[]): Promise<T> {
  const r = await sys.run("gh", ["api", "graphql", ...fields.flatMap((f) => ["-f", f])]);
  if (r.code !== 0) throw new HubError(`gh api graphql: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  const answer = JSON.parse(r.stdout) as Answer<T>;
  if (answer.data === undefined) throw new HubError(`github: ${answer.errors?.[0]?.message ?? "no data"}`);
  return answer.data;
}

function context(pr: Pr): string {
  return [pr.headRefName ?? "", (pr.body ?? "").slice(0, MAX_BODY)].join("\n");
}

export function prState(pr: Pr): { state: string; needsMe: boolean } {
  if (pr.merged) return { state: "merged", needsMe: false };
  if (pr.state === "CLOSED") return { state: "closed", needsMe: false };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { state: "changes requested", needsMe: true };
  const checks = pr.commits?.nodes[0]?.commit.statusCheckRollup?.state;
  if (checks === "FAILURE" || checks === "ERROR") return { state: "checks failing", needsMe: true };
  if (pr.reviewDecision === "APPROVED") return { state: "approved", needsMe: true };
  if (pr.isDraft) return { state: "draft", needsMe: false };
  if (pr.latestReviews?.nodes.some((r) => r.state === "COMMENTED")) return { state: "commented", needsMe: true };
  return { state: "in review", needsMe: false };
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
  const searched = await graphql<Searched>(sys, [
    `query=${SEARCH}`,
    `requested=${ctx.config.githubReviewQuery}`,
    `mine=${ctx.config.githubPrQuery} updated:>=${since}`,
  ]);
  const requested = searched.requested.nodes.filter((pr) => pr.url !== undefined);
  const out: unknown[] = requested.map((pr) => ({
    source: "github",
    kind: "review_request",
    url: pr.url,
    title: pr.title,
    author: pr.author?.login,
    state: "open",
    needs_me: true,
    context: context(pr),
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
  const stale = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE source = 'github' AND kind = 'pr' AND coalesce(state, '') NOT IN ('merged', 'closed')
       AND ignored IS NULL ORDER BY id`,
  );
  const prs = new Map<string, Pr>();
  for (let start = 0; start < stale.length; start += LOOKUP_BATCH) {
    const batch = stale.slice(start, start + LOOKUP_BATCH);
    const found = await graphql<Record<string, Pr | null>>(sys, [
      `query=${lookup(batch.length)}`,
      ...batch.map((i, n) => `p${n}=${i.url ?? i.ref}`),
    ]);
    for (const [n, i] of batch.entries()) {
      const pr = found[`p${n}`];
      if (pr?.url !== undefined) prs.set(i.ref, pr);
    }
  }
  for (const pr of searched.mine.nodes) {
    if (pr.url !== undefined) prs.set(pr.url, pr);
  }
  for (const [ref, pr] of prs) {
    const s = prState(pr);
    out.push({
      source: "github",
      kind: "pr",
      ref,
      url: pr.url,
      title: pr.title,
      author: pr.author?.login,
      state: s.state,
      needs_me: s.needsMe && pr.viewerDidAuthor === true,
      context: context(pr),
    });
  }
  return { items: out, cursor: started };
}

export const github: Fetcher = { name: "github", key: null, check, fetch: fetchGithub };
