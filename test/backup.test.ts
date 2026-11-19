import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { backup, backupDir, checkRestorable, listBackups } from "../src/backup.ts";
import { openDb, opensAs, SCHEMA_VERSION } from "../src/db.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-backup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the backup folder defaults to backups/ next to the database and expands ~", () => {
  assert.equal(backupDir("", "/data/hub.db"), "/data/backups");
  assert.equal(backupDir("~/Backups/hub", "/data/hub.db"), join(homedir(), "Backups/hub"));
  assert.equal(backupDir("/mnt/b", "/data/hub.db"), "/mnt/b");
});

test("a backup is a private copy named by time, and only the newest are kept", () => {
  const db = openDb(join(dir, "hub.db"));
  const folder = join(dir, "backups");
  for (let i = 0; i < 4; i++) backup(db, folder, new Date(Date.UTC(2026, 10, 19, 9, 0, i)), 3);
  db.close();
  assert.deepEqual(
    listBackups(folder).map((b) => b.name),
    ["hub-20261119-090003.db", "hub-20261119-090002.db", "hub-20261119-090001.db"],
  );
  assert.equal(statSync(join(folder, "hub-20261119-090003.db")).mode & 0o777, 0o600);
  assert.equal(checkRestorable(folder, "hub-20261119-090003.db"), join(folder, "hub-20261119-090003.db"));
});

test("a backup from an older schema opens through the upgrades, a newer or unknown one does not", () => {
  assert.equal(opensAs(SCHEMA_VERSION), true);
  assert.equal(opensAs("2"), true);
  assert.equal(opensAs("1"), false);
  assert.equal(opensAs("99"), false);
  assert.equal(opensAs(undefined), false);
});

test("only a backup by name with a schema this hub opens can be restored", () => {
  assert.throws(() => checkRestorable(dir, "../hub.db"), /not a backup name/);
  assert.throws(() => checkRestorable(dir, "hub-20261119-090000.db"), /no backup/);
  writeFileSync(join(dir, "hub-20261119-090000.db"), "");
  assert.throws(() => checkRestorable(dir, "hub-20261119-090000.db"), /schema v\?/);
});
