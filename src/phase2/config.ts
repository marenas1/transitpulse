import { resolve } from "node:path";

export type Phase2Config = {
  staticGtfsUrl: string;
  staticGtfsFile: string;
  phase1SampleFile: string;
  sampleLimit: number;
  serviceTimeZone: string;
};

const DEFAULT_STATIC_GTFS_URL =
  "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadPhase2Config(
  env: NodeJS.ProcessEnv = process.env,
): Phase2Config {
  return {
    staticGtfsUrl: env.TRANSITPULSE_STATIC_GTFS_URL ?? DEFAULT_STATIC_GTFS_URL,
    staticGtfsFile: resolve(
      env.TRANSITPULSE_STATIC_GTFS_FILE ?? "fixtures/mta-gtfs-subway.zip",
    ),
    phase1SampleFile: resolve(
      env.TRANSITPULSE_PHASE1_SAMPLE_FILE ??
        "fixtures/mta-nyct-gtfs.sample.json",
    ),
    sampleLimit: positiveInteger(env.TRANSITPULSE_SAMPLE_LIMIT, 10),
    serviceTimeZone: env.TRANSITPULSE_SERVICE_TIME_ZONE ?? "America/New_York",
  };
}
