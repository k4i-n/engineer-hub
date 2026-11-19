import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import { gate } from "../src/gate.ts";

const ACTIONS = DEFAULTS.recordActions;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bash(command: string): object {
  return { name: "Bash", input: { command } };
}

function tool(name: string): object {
  return { name: `mcp__plugin_engineer-hub_hub__${name}`, input: {} };
}

function transcript(...uses: object[]): string {
  const path = join(dir, "session.jsonl");
  const lines = [
    { type: "user", message: { content: "ship it" } },
    ...uses.map((use) => ({ type: "assistant", message: { content: [{ type: "tool_use", ...use }] } })),
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
  return path;
}

function stop(...uses: object[]): string {
  return gate({ hook_event_name: "Stop", transcript_path: transcript(...uses) }, ACTIONS);
}

test("an action followed by a hub write passes", () => {
  assert.equal(stop(bash("git push -u origin feat/x"), tool("link"), tool("ticket_set")), "");
  assert.equal(stop(bash("gh pr create --title x"), bash("hub log ENG-7 'opened the PR'")), "");
  assert.equal(stop(bash("git push && hub link ENG-7 https://example.com/pr/1")), "");
});

test("an action with no hub write after it blocks, naming the last commands", () => {
  const result = JSON.parse(
    stop(
      tool("log"),
      bash("git push"),
      bash("gh pr comment 1 --body ok"),
      bash("hub drafts"),
      bash("hub note-show ENG-7 Runbook"),
      bash("gh pr merge 1\n--merge"),
      bash("gh issue close 2"),
    ),
  ) as { decision: string; reason: string };
  assert.equal(result.decision, "block");
  assert.equal(
    result.reason,
    [
      "Nothing was recorded in hub after:",
      "- gh pr comment 1 --body ok",
      "- gh pr merge 1",
      "- gh issue close 2",
      "Record them before stopping: log or link on the ticket, then ticket_set next. If they belong to no ticket, log them on the day plan with day_set.",
    ].join("\n"),
  );
});

test("a read-only session passes", () => {
  assert.equal(stop(bash("git status"), bash("gh pr view 1"), tool("board"), { name: "Read", input: {} }), "");
});

test("an action named inside a heredoc body is not an action", () => {
  const note = "cat > notes.md <<'EOF'\nthen git push and gh pr merge 1\nEOF";
  assert.equal(stop(bash(note)), "");
  const result = stop(bash("git push"), bash("cat > notes.md <<EOF\nhub log ENG-7 pushed\nEOF"));
  assert.match(result, /"decision":"block"/);
});

test("no actions configured, a stop already blocked once, or no transcript passes", () => {
  const path = transcript(bash("git push"));
  assert.equal(gate({ transcript_path: path }, []), "");
  assert.equal(gate({ transcript_path: path, stop_hook_active: true }, ACTIONS), "");
  assert.equal(gate({ hook_event_name: "SubagentStop", transcript_path: path }, ACTIONS), "");
  assert.match(gate({ hook_event_name: "SubagentStop", agent_transcript_path: path }, ACTIONS), /block/);
});
