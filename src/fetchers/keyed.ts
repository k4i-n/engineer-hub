import type { Check } from "../fetch.ts";
import { findWay, type KeySpec, type System, storeCommands, type Way, wayText } from "../keys.ts";
import { HubError } from "../util.ts";

export async function keyCheck(sys: System, spec: KeySpec): Promise<Check> {
  const way = await findWay(sys, spec.source);
  if (way.kind !== "missing") return { ok: true, how: wayText(way), fix: [] };
  const c = storeCommands(spec, sys.platform);
  return { ok: false, how: `no ${spec.source} key`, fix: [c.hub, c.sealcall] };
}

export async function keyWay(sys: System, spec: KeySpec): Promise<Way> {
  const way = await findWay(sys, spec.source);
  if (way.kind === "missing") throw new HubError(`no ${spec.source} key`);
  return way;
}
