import "dotenv/config";

import { createApiServer } from "./api.js";
import { loadPhase4Config } from "./config.js";
import { PostgresAnalyticsRepository } from "./repository.js";

async function main(): Promise<void> {
  const config = loadPhase4Config();
  const repository = new PostgresAnalyticsRepository(
    config.databaseUrl,
    config.serviceTimeZone,
    config.databasePoolMax,
  );
  await repository.migrate();

  const server = createApiServer(repository, {
    feedName: config.feedName,
    staleSeconds: Math.ceil(config.staleAfterIntervals * config.pollIntervalMs / 1000),
    minimumRankingSamples: config.minimumRankingSamples,
  });

  const close = () => {
    server.close(() => {
      void repository.close();
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  server.listen(config.apiPort, config.apiHost, () => {
    console.log(JSON.stringify({
      status: "LISTENING",
      host: config.apiHost,
      port: config.apiPort,
      endpoints: ["/health", "/api/live/routes", "/api/analytics/network"],
    }));
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "FAIL", message }, null, 2));
  process.exitCode = 1;
});
