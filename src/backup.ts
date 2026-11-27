import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { opensAs, SCHEMA_VERSION } from "./db.ts";
import { HubError } from "./util.ts";

export type Backup = { name: string; path: string; size: number; at: string };
export type BackupState = { at: string; name: string | null; error: string | null };

const NAME = /^hub-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(-before-(?:restore|delete|merge))?(-\d+)?\.db$/;

export function backupDir(setting: string, dbPath: string): string {
  if (setting === "") return join(dirname(resolve(dbPath)), "backups");
  if (setting === "~" || setting.startsWith("~/")) return join(homedir(), setting.slice(1));
  return resolve(setting);
}

function stamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

export function listBackups(dir: string): Backup[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const m = NAME.exec(name);
      if (m === null) return [];
      const path = join(dir, name);
      const at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
      return [{ name, path, size: statSync(path).size, at }];
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function filesOf(backupPath: string): string {
  return backupPath.replace(/\.db$/, ".files");
}

export function backup(db: DatabaseSync, dir: string, files: string, now: Date, keep: number, suffix = ""): Backup {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = `hub-${stamp(now)}${suffix}.db`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `hub-${stamp(now)}${suffix}-${n}.db`;
  const path = join(dir, name);
  db.prepare("VACUUM INTO ?").run(path);
  chmodSync(path, 0o600);
  if (existsSync(files)) cpSync(files, filesOf(path), { recursive: true, preserveTimestamps: true });
  else mkdirSync(filesOf(path), { mode: 0o700 });
  for (const old of listBackups(dir).slice(keep)) {
    rmSync(old.path);
    rmSync(filesOf(old.path), { recursive: true, force: true });
  }
  return { name, path, size: statSync(path).size, at: now.toISOString() };
}

function schemaOf(path: string): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export function checkRestorable(dir: string, name: string): string {
  if (!NAME.test(name)) throw new HubError(`${name} is not a backup name (hub backups lists them)`);
  const path = join(dir, name);
  if (!existsSync(path)) throw new HubError(`no backup ${name} in ${dir}`);
  const schema = schemaOf(path);
  if (!opensAs(schema)) {
    throw new HubError(`${name} has schema v${schema ?? "?"}, this hub needs v${SCHEMA_VERSION}`);
  }
  return path;
}

export function replaceDb(dbPath: string, files: string, source: string): void {
  for (const extra of ["-wal", "-shm"]) rmSync(`${dbPath}${extra}`, { force: true });
  copyFileSync(source, dbPath);
  chmodSync(dbPath, 0o600);
  if (!existsSync(filesOf(source))) return;
  rmSync(files, { recursive: true, force: true });
  cpSync(filesOf(source), files, { recursive: true, preserveTimestamps: true });
}
