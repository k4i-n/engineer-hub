#!/usr/bin/env node
// hub source add pagerduty --every 5m -- node examples/sources/pagerduty.mjs
// Key: a PagerDuty user API token, stored as sealcall route "pagerduty" or Keychain item engineer-hub/pagerduty.
import { spawnSync } from "node:child_process";

const NAME = "pagerduty";
const HOST = "api.pagerduty.com";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function get(path) {
  const routes = spawnSync("sealcall", ["routes"], { encoding: "utf8" });
  if (routes.status === 0 && routes.stdout.split("\n").some((l) => l.split(/\s+/)[0] === NAME)) {
    const r = spawnSync(
      "sealcall",
      ["call", NAME, "GET", path, "-H", "Accept: application/vnd.pagerduty+json;version=2"],
      {
        encoding: "utf8",
      },
    );
    if (r.status !== 0) fail(r.stderr.trim());
    return JSON.parse(r.stdout);
  }
  const key =
    process.env.PAGERDUTY_KEY ??
    spawnSync("security", ["find-generic-password", "-s", "engineer-hub", "-a", NAME, "-w"], {
      encoding: "utf8",
    }).stdout?.trim();
  if (!key) fail(`no ${NAME} key: security add-generic-password -s engineer-hub -a ${NAME} -w`);
  const r = await fetch(`https://${HOST}${path}`, {
    headers: { Authorization: `Token token=${key}`, Accept: "application/vnd.pagerduty+json;version=2" },
  });
  if (!r.ok) fail(`${HOST} answered ${r.status}`);
  return r.json();
}

const me = (await get("/users/me")).user.id;
const { incidents } = await get(`/incidents?statuses[]=triggered&statuses[]=acknowledged&user_ids[]=${me}&limit=50`);
for (const i of incidents) {
  const line = {
    kind: "alert",
    ref: `pagerduty:${i.id}`,
    url: i.html_url,
    title: `[${i.urgency}] ${i.title}`,
    state: i.status,
    needs_me: i.status === "triggered",
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
