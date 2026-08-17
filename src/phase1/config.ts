export type Phase1Config = {
  feedName: string;
  feedUrl: string;
  apiKey?: string;
  inputFile?: string;
  sampleLimit: number;
  requestTimeoutMs: number;
};

const DEFAULT_FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Phase1Config {
  return {
    feedName: env.TRANSITPULSE_FEED_NAME ?? "nyct-1-2-3-4-5-6-7",
    feedUrl: env.TRANSITPULSE_FEED_URL ?? DEFAULT_FEED_URL,
    apiKey: env.TRANSITPULSE_API_KEY || undefined,
    inputFile: env.TRANSITPULSE_INPUT_FILE || undefined,
    sampleLimit: positiveInteger(env.TRANSITPULSE_SAMPLE_LIMIT, 10),
    requestTimeoutMs: positiveInteger(
      env.TRANSITPULSE_REQUEST_TIMEOUT_MS,
      20_000,
    ),
  };
}
