import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { all } from "./db.ts";
import { HubError } from "./util.ts";

export type FileEntry = { path: string; size: number; modified: string };

const TEXT = new Set([".md", ".markdown", ".txt", ".csv", ".json", ".html", ".htm"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export type Show = "markdown" | "html" | "image" | "raw";
const MAX_INDEXED = 1_000_000;

export function show(path: string): Show {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  if (IMAGE.has(ext)) return "image";
  return "raw";
}

export function fileHref(id: string, path: string, raw = false): string {
  const parts = [id, ...path.split("/")].map(encodeURIComponent);
  return `/t/${parts[0]}/${raw ? "raw" : "files"}/${parts.slice(1).join("/")}`;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function filesRoot(dbPath: string): string {
  return join(dirname(resolve(dbPath)), "files");
}

export function ticketFolder(root: string, id: string): string {
  if (id === "" || id === "." || id === ".." || /[/\\]/.test(id)) {
    throw new HubError(`ticket id ${id} cannot name a files folder`);
  }
  return join(root, id);
}

export function relPath(input: string): string {
  const rel = posix.normalize(input.replaceAll("\\", "/")).replace(/\/+$/, "");
  const parts = rel.split("/");
  if (isAbsolute(input) || rel === "" || rel === "." || parts.some((p) => p === ".." || p.startsWith("."))) {
    throw new HubError(`${input} is not a path inside the ticket's folder (relative, no .. or hidden names)`);
  }
  return rel;
}

function walk(folder: string, prefix = ""): FileEntry[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .flatMap((e) => {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      const full = join(folder, e.name);
      if (e.isDirectory()) return walk(full, rel);
      if (!e.isFile()) return [];
      const s = statSync(full);
      return [{ path: rel, size: s.size, modified: s.mtime.toISOString() }];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function listFiles(root: string, id: string): FileEntry[] {
  return walk(ticketFolder(root, id));
}

export function fileCount(root: string, id: string): number {
  return listFiles(root, id).length;
}

export function insideFolder(root: string, id: string, rel: string): string {
  const folder = ticketFolder(root, id);
  const full = join(folder, relPath(rel));
  if (!existsSync(full)) throw new HubError(`no file ${rel} on ${id} (hub files ${id} lists them)`);
  const real = realpathSync(full);
  if (!real.startsWith(realpathSync(folder) + sep)) throw new HubError(`${rel} points outside ${id}'s folder`);
  return real;
}

function moveAcross(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    rmSync(src, { recursive: true });
  }
}

export function addFile(root: string, id: string, src: string, as: string | null, move: boolean): string {
  if (!isAbsolute(src)) throw new HubError(`${src} must be an absolute path`);
  if (!existsSync(src)) throw new HubError(`no file or folder ${src}`);
  const rel = relPath(as ?? basename(src));
  const dest = join(ticketFolder(root, id), rel);
  if (existsSync(dest)) throw new HubError(`${rel} already exists on ${id}: remove it first or add with --as <path>`);
  mkdirSync(dirname(dest), { recursive: true });
  if (move) moveAcross(src, dest);
  else cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return rel;
}

export function removeFile(root: string, id: string, rel: string): string {
  const path = relPath(rel);
  const full = join(ticketFolder(root, id), path);
  if (!existsSync(full)) throw new HubError(`no file ${path} on ${id} (hub files ${id} lists them)`);
  rmSync(full, { recursive: true });
  return path;
}

export function checkFolderFree(root: string, id: string): void {
  const folder = ticketFolder(root, id);
  if (existsSync(folder)) throw new HubError(`${folder} already exists: move it aside first`);
}

export function moveFolder(root: string, id: string, to: string): void {
  const from = ticketFolder(root, id);
  if (!existsSync(from)) return;
  moveAcross(from, ticketFolder(root, to));
}

export function mergeFolder(root: string, id: string, into: string): void {
  const from = ticketFolder(root, id);
  if (!existsSync(from)) return;
  const target = ticketFolder(root, into);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(from)) {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const dest = existsSync(join(target, name)) ? `${stem} (from ${id})${ext}` : name;
    moveAcross(join(from, name), join(target, dest));
  }
  rmSync(from, { recursive: true });
}

export function removeFolder(root: string, id: string): void {
  rmSync(ticketFolder(root, id), { recursive: true, force: true });
}
export function isText(path: string): boolean {
  return TEXT.has(extname(path).toLowerCase());
}

function htmlText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function indexedText(full: string, path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(full, "utf8").slice(0, MAX_INDEXED);
  } catch {
    return null;
  }
  return /\.html?$/i.test(path) ? htmlText(raw) : raw;
}

type Indexed = { id: number; ticket_id: string; path: string; size: number; modified: string };

export function reindex(db: DatabaseSync, root: string): void {
  const known = new Map(
    all<Indexed>(db, "SELECT id, ticket_id, path, size, modified FROM file").map((r) => [
      `${r.ticket_id}/${r.path}`,
      r,
    ]),
  );
  const tickets = new Set(all<{ id: string }>(db, "SELECT id FROM ticket").map((t) => t.id));
  const ids = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && tickets.has(e.name))
        .map((e) => e.name)
    : [];
  const upsert = db.prepare(
    `INSERT INTO file(ticket_id, path, size, modified, body) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id, path) DO UPDATE SET size = excluded.size, modified = excluded.modified, body = excluded.body`,
  );
  for (const id of ids) {
    for (const f of walk(join(root, id)).filter((e) => isText(e.path))) {
      const key = `${id}/${f.path}`;
      const row = known.get(key);
      known.delete(key);
      if (row !== undefined && row.size === f.size && row.modified === f.modified) continue;
      const body = indexedText(join(root, id, f.path), f.path);
      if (body !== null) upsert.run(id, f.path, f.size, f.modified, body);
    }
  }
  const drop = db.prepare("DELETE FROM file WHERE id = ?");
  for (const row of known.values()) drop.run(row.id);
}
