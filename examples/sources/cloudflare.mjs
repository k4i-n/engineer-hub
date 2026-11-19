#!/usr/bin/env node
// hub source add cloudflare --every 5m -- node examples/sources/cloudflare.mjs <account id>
// Key: a Cloudflare API token with Account > Notifications: Read, stored as sealcall route "cloudflare"
// or Keychain item engineer-hub/cloudflare. Lists notifications Cloudflare sent since the last run.
import { spawnSync } from "node:child_process";

const NAME = "cloudflare";
const HOST = "api.cloudflare.com";
const account = process.argv[2];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function get(path) {
  const routes = spawnSync("sealcall", ["routes"], { encoding: "utf8" });
  if (routes.status === 0 && routes.stdout.split("\n").some((l) => l.split(/\s+/)[0] === NAME)) {
    const r = spawnSync("sealcall", ["call", NAME, "GET", path], { encoding: "utf8" });
    if (r.status !== 0) fail(r.stderr.trim());
    return JSON.parse(r.stdout);
  }
  const key =
    process.env.CLOUDFLARE_KEY ??
    spawnSync("security", ["find-generic-password", "-s", "engineer-hub", "-a", NAME, "-w"], {
      encoding: "utf8",
    }).stdout?.trim();
  if (!key) fail(`no ${NAME} key: security add-generic-password -s engineer-hub -a ${NAME} -w`);
  const r = await fetch(`https://${HOST}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) fail(`${HOST} answered ${r.status}`);
  return r.json();
}

if (!/^[0-9a-f]{32}$/.test(account ?? "")) fail("give the Cloudflare account id as the first argument");
const since = process.env.HUB_SINCE || new Date(Date.now() - 86_400_000).toISOString();
const { result } = await get(
  `/client/v4/accounts/${account}/alerting/v3/history?since=${encodeURIComponent(since)}&per_page=50`,
);
for (const n of result ?? []) {
  const line = {
    kind: "alert",
    ref: `cloudflare:${n.id}`,
    url: `https://dash.cloudflare.com/${account}/notifications`,
    title: `${n.name}: ${String(n.alert_body ?? "").slice(0, 160)}`,
    state: n.alert_type,
    needs_me: true,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
