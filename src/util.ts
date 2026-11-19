export class HubError extends Error {}

type Parts = { year: string; month: string; day: string; hour: string; minute: string };

function zoned(now: Date, timezone: string): Parts {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(now)) parts[part.type] = part.value;
  return {
    year: parts.year ?? "",
    month: parts.month ?? "",
    day: parts.day ?? "",
    hour: parts.hour ?? "",
    minute: parts.minute ?? "",
  };
}

export function today(now: Date, timezone: string): string {
  const p = zoned(now, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function nowTs(now: Date, timezone: string): string {
  const p = zoned(now, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function nowIso(now: Date): string {
  return now.toISOString();
}

const DURATION = /^(\d+)([mhd])$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function afterDuration(now: Date, value: string, flag: string): string {
  const match = DURATION.exec(value);
  const unit = UNIT_MS[match?.[2] ?? ""];
  if (!match || unit === undefined) throw new HubError(`${flag} takes a duration such as 30m, 4h or 2d, not ${value}`);
  return new Date(now.getTime() + Number(match[1]) * unit).toISOString();
}

export function laterTime(now: Date, value: string, timezone: string, hour: number, flag: string): string {
  if (value !== "tomorrow") return afterDuration(now, value, flag);
  const start = Date.parse(startOfDayIso(shiftDate(today(now, timezone), 1), timezone));
  return new Date(start + hour * 3_600_000).toISOString();
}

export function cut(value: string, max: number): string {
  const line = value.replace(/\s*\n\s*/g, " ");
  if (line.length <= max) return line;
  return `${line.slice(0, max - 3)}...`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sinceDate(arg: string, now: Date, timezone: string): string {
  if (arg === "today") return today(now, timezone);
  if (arg === "yesterday") return shiftDate(today(now, timezone), -1);
  if (DATE.test(arg)) return arg;
  throw new HubError(`--since takes YYYY-MM-DD, today or yesterday, not ${arg}`);
}

export function startOfDayIso(date: string, timezone: string): string {
  const guess = new Date(`${date}T00:00:00Z`);
  const p = zoned(guess, timezone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess.getTime() - (asUtc - guess.getTime())).toISOString();
}

function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostIs(h: string, domain: string): boolean {
  return h === domain || h.endsWith(`.${domain}`);
}

export function linkSource(url: string, trackerHosts: string[]): string {
  if (url.startsWith("file:") || url.startsWith("/") || url.startsWith("~")) return "file";
  const h = host(url);
  if (trackerHosts.some((t) => hostIs(h, t.toLowerCase()))) return "tracker";
  if (hostIs(h, "github.com")) return "github";
  if (hostIs(h, "slack.com")) return "slack";
  if (hostIs(h, "notion.so") || hostIs(h, "notion.site")) return "notion";
  if (h.includes("grafana")) return "grafana";
  return "other";
}

export function linkKind(url: string, source: string): string {
  if (/\/pull\/\d+/.test(url)) return "pr";
  if (/\/issues\/\d+/.test(url)) return "issue";
  if (/\/actions\/runs\/\d+/.test(url)) return "run";
  if (source === "tracker") return "issue";
  if (source === "slack") return "thread";
  if (source === "notion" || source === "file" || hostIs(host(url), "docs.google.com")) return "doc";
  return "other";
}
