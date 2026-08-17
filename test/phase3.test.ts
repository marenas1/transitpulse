import assert from "node:assert/strict";
import { test } from "node:test";

import { loadStaticGtfs } from "../src/phase2/index.js";
import {
  IngestionWorker,
  type ObservationStore,
  type PersistBatch,
  type PersistStats,
  type IngestionRunInput,
} from "../src/phase3/index.js";

class FakeObservationStore implements ObservationStore {
  private readonly tripKeys = new Set<string>();
  private readonly stopKeys = new Set<string>();
  readonly runs: IngestionRunInput[] = [];

  async persistBatch(batch: PersistBatch): Promise<PersistStats> {
    let tripInserted = 0;
    let stopInserted = 0;

    for (const row of batch.tripObservations) {
      const key = `${row.feedName}:${row.feedTimestamp}:${row.sourceEntityKey}`;
      if (this.tripKeys.has(key)) continue;
      this.tripKeys.add(key);
      tripInserted += 1;
    }
    for (const row of batch.stopTimeObservations) {
      const key = `${row.feedName}:${row.feedTimestamp}:${row.sourceEntityKey}`;
      if (this.stopKeys.has(key)) continue;
      this.stopKeys.add(key);
      stopInserted += 1;
    }

    return {
      tripCandidates: batch.tripObservations.length,
      stopCandidates: batch.stopTimeObservations.length,
      tripInserted,
      stopInserted,
      duplicatesIgnored:
        batch.tripObservations.length +
        batch.stopTimeObservations.length -
        tripInserted -
        stopInserted,
    };
  }

  async recordIngestionRun(run: IngestionRunInput): Promise<void> {
    this.runs.push(run);
  }
}

test("worker persists a captured feed and counts replayed rows as duplicates", async () => {
  const snapshot = await loadStaticGtfs("fixtures/mta-gtfs-subway.zip");
  const store = new FakeObservationStore();
  let clockTick = 0;
  const worker = new IngestionWorker(
    {
      feedName: "nyct-1-2-3-4-5-6-7",
      feedUrl: "unused-in-fixture-mode",
      feedInputFile: "fixtures/mta-nyct-gtfs.bin",
      requestTimeoutMs: 20_000,
      pollIntervalMs: 1,
      maxCycles: 2,
      serviceTimeZone: "America/New_York",
    },
    snapshot,
    store,
    {
      now: () => `2026-08-17T15:30:0${clockTick++}.000Z`,
      sleep: async () => undefined,
    },
  );

  const results = await worker.run();

  assert.equal(results.length, 2);
  assert.ok(results[0].persistStats);
  assert.ok((results[0].persistStats?.tripInserted ?? 0) > 0);
  assert.ok((results[0].persistStats?.stopInserted ?? 0) > 0);
  assert.ok((results[1].persistStats?.duplicatesIgnored ?? 0) > 0);
  assert.equal(results[1].persistStats?.tripInserted, 0);
  assert.equal(results[1].persistStats?.stopInserted, 0);
  assert.equal(store.runs.length, 2);
  assert.ok(store.runs.every((run) => run.errorCount === 0));
});
