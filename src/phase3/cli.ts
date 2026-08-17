import "dotenv/config";

import { loadStaticGtfs } from "../phase2/index.js";
import { loadPhase3Config } from "./config.js";
import { PostgresObservationStore } from "./repository.js";
import { IngestionWorker } from "./worker.js";

async function main(): Promise<void> {
  const config = loadPhase3Config();
  const snapshot = await loadStaticGtfs(config.staticGtfsFile);
  const store = new PostgresObservationStore(
    config.databaseUrl,
    config.databasePoolMax,
  );
  const worker = new IngestionWorker(config, snapshot, store);

  const stop = () => worker.requestStop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await store.migrate();
    if (config.importStatic) await store.importStaticSnapshot(snapshot);
    const results = await worker.run();
    console.log(JSON.stringify({ status: "COMPLETE", results }, null, 2));
    if (results.some((result) => result.status === "failed")) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await store.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "FAIL", message }, null, 2));
  process.exitCode = 1;
});
