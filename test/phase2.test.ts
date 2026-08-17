import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  loadStaticGtfs,
  materializeTripStopTimes,
  normalizeGtfsTime,
  serviceDateForTimestamp,
} from "../src/phase2/index.js";
import { resolveRealtimeSample } from "../src/phase2/resolve.js";

const staticFile = "fixtures/mta-gtfs-subway.zip";
const sampleFile = "fixtures/mta-nyct-gtfs.sample.json";

test("normalizes GTFS after-midnight times without changing service date", () => {
  const normalized = normalizeGtfsTime("2026-08-17", "24:08:00");
  assert.equal(normalized.serviceDate, "2026-08-17");
  assert.equal(normalized.normalizedLocalDateTime, "2026-08-18T00:08:00");
  assert.equal(normalized.secondsSinceServiceMidnight, 86_880);
  assert.equal(normalized.dayOffset, 1);
});

test("derives the NYC service date from a feed timestamp", () => {
  assert.equal(
    serviceDateForTimestamp("2026-08-17T03:30:00.000Z", "America/New_York"),
    "2026-08-16",
  );
});

test("imports static reference data and scheduled stop times", async () => {
  const snapshot = await loadStaticGtfs(staticFile);
  assert.ok(snapshot.counts.routes > 0);
  assert.ok(snapshot.counts.stations > 0);
  assert.ok(snapshot.counts.stops > 0);
  assert.ok(snapshot.counts.trips > 0);
  assert.ok(snapshot.counts.scheduledStopTimes > 0);
  assert.ok(snapshot.counts.afterMidnightStopTimes > 0);
});

test("resolves the Phase 1 sample against static trips and stops", async () => {
  const [snapshot, sampleJson] = await Promise.all([
    loadStaticGtfs(staticFile),
    readFile(sampleFile, "utf8"),
  ]);
  const sample = JSON.parse(sampleJson) as {
    records: Parameters<typeof resolveRealtimeSample>[1];
  };
  const report = resolveRealtimeSample(
    snapshot,
    sample.records.slice(0, 10),
    "America/New_York",
  );

  assert.equal(report.summary.ambiguousTrips, 0);
  assert.ok(report.summary.resolved >= 10);
  assert.equal(report.summary.unresolved, 0);

  const schedule = materializeTripStopTimes(
    snapshot,
    report.resolvedRecords[0].staticTripId,
    report.serviceDate,
  );
  assert.ok(schedule.length > 0);
  assert.equal(schedule[0].arrivalTime.serviceDate, report.serviceDate);
});
