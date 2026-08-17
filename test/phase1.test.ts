import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  decodeFeed,
  distinctTripRecords,
  FeedDecodeError,
  normalizeStopTimeRecords,
  normalizeTripUpdates,
} from "../src/phase1/index.js";

test("normalizes a trip update into the Phase 1 contract", () => {
  const records = normalizeTripUpdates(
    {
      header: { timestamp: 1_755_447_600 },
      entity: [
        {
          tripUpdate: {
            trip: {
              routeId: "2",
              tripId: "trip-001",
              directionId: "0",
              startTime: "17:32:00",
            },
            stopTimeUpdate: [
              {
                stopId: "127N",
                arrival: { time: 1_755_448_680, delay: 180 },
              },
            ],
          },
        },
      ],
    },
    "fixture",
    "2026-08-17T15:20:04.000Z",
  );

  assert.deepEqual(records[0], {
    feedName: "fixture",
    feedTimestamp: "2025-08-17T16:20:00.000Z",
    observedAt: "2026-08-17T15:20:04.000Z",
    routeId: "2",
    tripId: "trip-001",
    directionId: "0",
    startTime: "17:32:00",
    stopId: "127N",
    scheduledArrival: null,
    predictedArrival: "2025-08-17T16:38:00.000Z",
    delaySeconds: 180,
  });
});

test("keeps only one representative record per distinct trip", () => {
  const records = [
    { tripId: "a" },
    { tripId: "a" },
    { tripId: "b" },
  ] as Parameters<typeof distinctTripRecords>[0];

  assert.deepEqual(
    distinctTripRecords(records).map((record) => record.tripId),
    ["a", "b"],
  );
});

test("can normalize every stop-time update for persistence", () => {
  const records = normalizeStopTimeRecords(
    {
      header: { timestamp: 1_755_447_600 },
      entity: [
        {
          tripUpdate: {
            trip: { routeId: "2", tripId: "trip-001" },
            stopTimeUpdate: [
              { stopId: "127N", stopSequence: 1, arrival: { delay: 60 } },
              { stopId: "128N", stopSequence: 2, arrival: { delay: 120 } },
            ],
          },
        },
      ],
    },
    "fixture",
    "2026-08-17T15:20:04.000Z",
  );

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [record.stopId, record.stopSequence]),
    [
      ["127N", 1],
      ["128N", 2],
    ],
  );
});

test("exposes malformed protobuf as a decode failure", () => {
  assert.throws(() => decodeFeed(new Uint8Array([0xff, 0xff])), FeedDecodeError);
});

test("captured MTA fixture satisfies the 10-distinct-trip gate", () => {
  const body = readFileSync("fixtures/mta-nyct-gtfs.bin");
  const feed = decodeFeed(body);
  const records = normalizeTripUpdates(
    feed,
    "nyct-1-2-3-4-5-6-7",
    "2026-08-17T15:20:04.000Z",
  );
  const distinct = distinctTripRecords(records);

  assert.ok(distinct.length >= 10, `expected 10 trips, received ${distinct.length}`);
  assert.ok(distinct.every((record) => record.tripId.length > 0));
  assert.ok(distinct.every((record) => record.feedTimestamp !== null));
  assert.ok(distinct.every((record) => record.observedAt.length > 0));
});
