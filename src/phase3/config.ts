import { resolve } from "node:path";

export type Phase3Config = {
  databaseUrl: string;
  databasePoolMax: number;
  feedName: string;
  feedUrl: string;
  feedApiKey?: string;
  feedInputFile?: string;
  staticGtfsFile: string;
  serviceTimeZone: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  maxCycles: number;
  importStatic: boolean;
};

const DEFAULT_DATABASE_URL =
  "postgresql://transitpulse:transitpulse@localhost:5433/transitpulse";
const DEFAULT_FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadPhase3Config(
  env: NodeJS.ProcessEnv = process.env,
): Phase3Config {
  return {
    databaseUrl: env.TRANSITPULSE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    databasePoolMax: positiveInteger(env.TRANSITPULSE_DATABASE_POOL_MAX, 4),
    feedName: env.TRANSITPULSE_FEED_NAME ?? "nyct-1-2-3-4-5-6-7",
    feedUrl: env.TRANSITPULSE_FEED_URL ?? DEFAULT_FEED_URL,
    feedApiKey: env.TRANSITPULSE_API_KEY || undefined,
    feedInputFile: env.TRANSITPULSE_FEED_INPUT_FILE || undefined,
    staticGtfsFile: resolve(
      env.TRANSITPULSE_STATIC_GTFS_FILE ?? "fixtures/mta-gtfs-subway.zip",
    ),
    serviceTimeZone: env.TRANSITPULSE_SERVICE_TIME_ZONE ?? "America/New_York",
    requestTimeoutMs: positiveInteger(
      env.TRANSITPULSE_REQUEST_TIMEOUT_MS,
      20_000,
    ),
    pollIntervalMs: positiveInteger(env.TRANSITPULSE_POLL_INTERVAL_MS, 30_000),
    maxCycles: nonNegativeInteger(env.TRANSITPULSE_MAX_CYCLES, 0),
    importStatic: booleanValue(env.TRANSITPULSE_IMPORT_STATIC, true),
  };
}
