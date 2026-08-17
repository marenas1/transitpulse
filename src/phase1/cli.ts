import "dotenv/config";

import { readFile } from "node:fs/promises";

import {
  decodeFeed,
  distinctTripRecords,
  FeedDecodeError,
  fetchFeed,
  loadConfig,
  normalizeTripUpdates,
} from "./index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const observedAt = new Date().toISOString();

  try {
    const fetched = config.inputFile
      ? {
          body: new Uint8Array(await readFile(config.inputFile)),
          status: 200,
          contentType: "application/x-protobuf",
          fetchedAt: new Date().toISOString(),
        }
      : await fetchFeed(
          config.feedUrl,
          config.apiKey,
          config.requestTimeoutMs,
        );
    const feed = decodeFeed(fetched.body);
    const allRecords = normalizeTripUpdates(feed, config.feedName, observedAt);
    const records = distinctTripRecords(allRecords).slice(0, config.sampleLimit);
    const distinctTrips = new Set(allRecords.map((record) => record.tripId));
    const header = feed.header as { timestamp?: unknown };

    const output = {
      status: records.length >= config.sampleLimit ? "PASS" : "FAIL",
      gate: `at least ${config.sampleLimit} distinct trips`,
      feed: {
        name: config.feedName,
        source: config.inputFile ?? config.feedUrl,
        httpStatus: fetched.status,
        contentType: fetched.contentType,
        fetchedAt: fetched.fetchedAt,
        feedTimestamp: header.timestamp
          ? new Date(Number(header.timestamp) * 1000).toISOString()
          : null,
        byteLength: fetched.body.byteLength,
      },
      summary: {
        entities: feed.entity.length,
        tripUpdates: allRecords.length,
        distinctTrips: distinctTrips.size,
        decodeFailures: 0,
      },
      records,
    };

    console.log(JSON.stringify(output, null, 2));

    if (output.status !== "PASS") {
      process.exitCode = 1;
    }
  } catch (error) {
    const stage = error instanceof FeedDecodeError ? "decode" : "fetch";
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify(
        {
          status: "FAIL",
          stage,
          decodeFailures: stage === "decode" ? 1 : 0,
          message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

void main();
