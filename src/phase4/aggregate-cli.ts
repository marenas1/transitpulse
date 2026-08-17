import "dotenv/config";

import { loadPhase4Config } from "./config.js";
import { PostgresAnalyticsRepository } from "./repository.js";

function date(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const config = loadPhase4Config();
  const repository = new PostgresAnalyticsRepository(
    config.databaseUrl,
    config.serviceTimeZone,
    config.databasePoolMax,
  );
  try {
    await repository.migrate();
    const to = process.env.TRANSITPULSE_AGGREGATE_TO ?? date(new Date());
    const from = process.env.TRANSITPULSE_AGGREGATE_FROM ?? date(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    await repository.refreshDailyAggregates(from, to);
    console.log(JSON.stringify({ status: "COMPLETE", from, to }));
  } finally {
    await repository.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "FAIL", message }, null, 2));
  process.exitCode = 1;
});
