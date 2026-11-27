import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { backup, backupDir, checkRestorable, filesOf, listBackups, replaceDb } from "../src/backup.ts";
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
  for (let i = 0; i < 4; i++) backup(db, folder, join(dir, "files"), new Date(Date.UTC(2026, 10, 19, 9, 0, i)), 3);
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

test("a backup copies the files folder beside it, pruning drops both, and restore puts the files back", () => {
  const dbFile = join(dir, "hub.db");
  const files = join(dir, "files");
  const db = openDb(dbFile);
  const folder = join(dir, "backups");
  backup(db, folder, files, new Date(Date.UTC(2026, 10, 19, 9, 0, 0)), 2);
  mkdirSync(join(files, "ENG-1"), { recursive: true });
  writeFileSync(join(files, "ENG-1", "plan.md"), "v1");
  const kept = backup(db, folder, files, new Date(Date.UTC(2026, 10, 19, 9, 0, 1)), 2);
  backup(db, folder, files, new Date(Date.UTC(2026, 10, 19, 9, 0, 2)), 2);
  db.close();
  assert.deepEqual(readdirSync(folder).sort(), [
    "hub-20261119-090001.db",
    "hub-20261119-090001.files",
    "hub-20261119-090002.db",
    "hub-20261119-090002.files",
  ]);
  assert.equal(readFileSync(join(filesOf(kept.path), "ENG-1", "plan.md"), "utf8"), "v1");

  writeFileSync(join(files, "ENG-1", "plan.md"), "v2");
  writeFileSync(join(files, "ENG-1", "later.md"), "new");
  replaceDb(dbFile, files, kept.path);
  assert.deepEqual(readdirSync(join(files, "ENG-1")), ["plan.md"]);
  assert.equal(readFileSync(join(files, "ENG-1", "plan.md"), "utf8"), "v1");

  const old = join(folder, "hub-20261118-090000.db");
  writeFileSync(old, readFileSync(kept.path));
  replaceDb(dbFile, files, old);
  assert.equal(readFileSync(join(files, "ENG-1", "plan.md"), "utf8"), "v1");
});
