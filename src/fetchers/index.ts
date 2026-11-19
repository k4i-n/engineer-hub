import type { Fetcher } from "../fetch.ts";
import { github } from "./github.ts";
import { linear } from "./linear.ts";
import { slack } from "./slack.ts";

export const FETCHERS: Fetcher[] = [github, linear, slack];
