import { loadPhase3Config } from "../phase3/config.js";
import { DEFAULT_MINIMUM_RANKING_SAMPLES } from "./metrics.js";

export type Phase4Config = {
  databaseUrl: string;
  databasePoolMax: number;
  feedName: string;
  serviceTimeZone: string;
  pollIntervalMs: number;
  apiHost: string;
  apiPort: number;
  staleAfterIntervals: number;
  minimumRankingSamples: number;
};

function integer(value: string | undefined, fallback: number, minimum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadPhase4Config(
  env: NodeJS.ProcessEnv = process.env,
): Phase4Config {
  const phase3 = loadPhase3Config(env);
  return {
    databaseUrl: phase3.databaseUrl,
    databasePoolMax: phase3.databasePoolMax,
    feedName: phase3.feedName,
    serviceTimeZone: phase3.serviceTimeZone,
    pollIntervalMs: phase3.pollIntervalMs,
    apiHost: env.TRANSITPULSE_API_HOST ?? "127.0.0.1",
    apiPort: integer(env.TRANSITPULSE_API_PORT, 8080, 1),
    staleAfterIntervals: integer(env.TRANSITPULSE_STALE_AFTER_INTERVALS, 2, 1),
    minimumRankingSamples: integer(
      env.TRANSITPULSE_MINIMUM_RANKING_SAMPLES,
      DEFAULT_MINIMUM_RANKING_SAMPLES,
      1,
    ),
  };
}
