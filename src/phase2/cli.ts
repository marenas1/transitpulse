import "dotenv/config";

import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import { loadPhase2Config } from "./config.js";
import {
  loadStaticGtfs,
  normalizeGtfsTime,
  materializeTripStopTimes,
} from "./gtfs.js";
import { resolveRealtimeSample, type RealtimeSampleRecord } from "./resolve.js";

type Phase1Sample = {
  records: RealtimeSampleRecord[];
};

async function main(): Promise<void> {
  const config = loadPhase2Config();
  const snapshot = await loadStaticGtfs(config.staticGtfsFile);
  const sample = JSON.parse(
    await readFile(config.phase1SampleFile, "utf8"),
  ) as Phase1Sample;
  const records = sample.records.slice(0, config.sampleLimit);
  const resolution = resolveRealtimeSample(
    snapshot,
    records,
    config.serviceTimeZone,
  );
  const midnightExample = normalizeGtfsTime("2026-08-17", "24:08:00");
  const materializedExample = resolution.resolvedRecords[0]
    ? materializeTripStopTimes(
        snapshot,
        resolution.resolvedRecords[0].staticTripId,
        resolution.serviceDate,
      ).slice(0, 3)
    : [];
  const gatePassed =
    resolution.summary.resolved >= config.sampleLimit &&
    resolution.summary.ambiguousTrips === 0 &&
    midnightExample.normalizedLocalDateTime === "2026-08-18T00:08:00" &&
    midnightExample.dayOffset === 1;
  const sourceFile = relative(process.cwd(), config.staticGtfsFile) || ".";

  console.log(
    JSON.stringify(
      {
        status: gatePassed ? "PASS" : "FAIL",
        gate: `at least ${config.sampleLimit} realtime trips resolve to static trips and stops`,
        source: {
          file: sourceFile,
          url: config.staticGtfsUrl,
          feedVersion: snapshot.feedVersion,
        },
        counts: snapshot.counts,
        serviceDate: resolution.serviceDate,
        midnightExample,
        resolution: {
          ...resolution.summary,
          distinctRealtimeTrips: resolution.distinctRealtimeTrips,
          resolved: resolution.resolvedRecords.slice(0, config.sampleLimit),
          mismatches: resolution.mismatches,
        },
        materializedScheduleExample: materializedExample,
      },
      null,
      2,
    ),
  );

  if (!gatePassed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "FAIL", message }, null, 2));
  process.exitCode = 1;
});
