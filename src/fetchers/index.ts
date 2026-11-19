import type { Fetcher } from "../fetch.ts";
import { github } from "./github.ts";

export const FETCHERS: Fetcher[] = [github];
