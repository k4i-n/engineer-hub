import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HubError } from "./util.ts";

export function tokenPath(dbFile: string): string {
  return join(dirname(dbFile), "token");
}

export function loadToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((statSync(path).mode & 0o077) !== 0) throw new HubError(`${path} is readable by others: chmod 600 ${path}`);
  const token = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HubError(`${path} does not hold a hub token: delete it and start again`);
  return token;
}
