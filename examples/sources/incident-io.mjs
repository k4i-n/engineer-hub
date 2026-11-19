#!/usr/bin/env node
// hub source add incident-io --every 5m -- node examples/sources/incident-io.mjs
// Key: an incident.io API key with read access, stored as sealcall route "incident-io" or Keychain item engineer-hub/incident-io.
import { spawnSync } from "node:child_process";

const NAME = "incident-io";
const HOST = "api.incident.io";

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
    process.env.INCIDENT_IO_KEY ??
    spawnSync("security", ["find-generic-password", "-s", "engineer-hub", "-a", NAME, "-w"], {
      encoding: "utf8",
    }).stdout?.trim();
  if (!key) fail(`no ${NAME} key: security add-generic-password -s engineer-hub -a ${NAME} -w`);
  const r = await fetch(`https://${HOST}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) fail(`${HOST} answered ${r.status}`);
  return r.json();
}

const { incidents } = await get("/v2/incidents?status_category[one_of]=live&page_size=50");
for (const i of incidents) {
  const line = {
    kind: "alert",
    ref: `incident-io:${i.id}`,
    url: i.permalink,
    title: `${i.reference} ${i.name}`,
    state: i.incident_status?.name,
    needs_me: true,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
