import { readFile } from "node:fs/promises";

import {
  decodeFeed,
  distinctTripRecords,
  fetchFeed,
  normalizeStopTimeRecords,
  normalizeTripUpdates,
  type NormalizedStopTimeRecord,
  type NormalizedTripRecord,
} from "../phase1/index.js";
import { resolveRealtimeSample, type ResolvedRealtimeRecord } from "../phase2/index.js";
import type { StaticGtfsSnapshot } from "../phase2/gtfs.js";
import {
  stopObservationFromNormalized,
  tripObservationFromNormalized,
  type IngestionRunInput,
  type ObservationStore,
  type PersistStats,
  type StopTimeObservationInput,
  type TripObservationInput,
} from "./repository.js";

export type WorkerConfig = {
  feedName: string;
  feedUrl: string;
  feedApiKey?: string;
  feedInputFile?: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  maxCycles: number;
  serviceTimeZone: string;
};

export type CycleResult = {
  status: "success" | "partial" | "failed";
  tripUpdates: number;
  stopUpdates: number;
  unresolvedReferences: number;
  rejectedRecords: number;
  persistStats: PersistStats | null;
  errorMessage: string | null;
};

export type WorkerClock = {
  now: () => string;
  sleep: (milliseconds: number) => Promise<void>;
};

const systemClock: WorkerClock = {
  now: () => new Date().toISOString(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

type FeedPayload = {
  body: Uint8Array;
  status: number;
  fetchedAt: string;
};

function resolvedByTrip(records: ResolvedRealtimeRecord[]): Map<string, ResolvedRealtimeRecord> {
  return new Map(records.map((record) => [record.realtimeTripId, record]));
}

function buildTripInputs(
  records: NormalizedTripRecord[],
  matches: Map<string, ResolvedRealtimeRecord>,
  snapshot: StaticGtfsSnapshot,
  serviceDate: string,
): { valid: TripObservationInput[]; rejected: number; unresolved: number } {
  const distinct = distinctTripRecords(records);
  const valid: TripObservationInput[] = [];
  let rejected = 0;
  let unresolved = 0;
  for (const record of distinct) {
    const match = matches.get(record.tripId);
    if (!match) unresolved += 1;
    const sanitized = {
      ...record,
      routeId: record.routeId && snapshot.routes.has(record.routeId)
        ? record.routeId
        : null,
      stopId: record.stopId && snapshot.stops.has(record.stopId)
        ? record.stopId
        : null,
    };
    try {
      valid.push(
        tripObservationFromNormalized(
          sanitized,
          match?.staticTripId ?? null,
          serviceDate,
        ),
      );
    } catch {
      rejected += 1;
    }
  }
  return { valid, rejected, unresolved };
}

function buildStopInputs(
  records: NormalizedStopTimeRecord[],
  matches: Map<string, ResolvedRealtimeRecord>,
  snapshot: StaticGtfsSnapshot,
  serviceDate: string,
): { valid: StopTimeObservationInput[]; rejected: number; unresolved: number } {
  const valid: StopTimeObservationInput[] = [];
  let rejected = 0;
  let unresolved = 0;
  for (const record of records) {
    const match = matches.get(record.tripId);
    if (!match) unresolved += 1;
    const sanitized = {
      ...record,
      routeId: record.routeId && snapshot.routes.has(record.routeId)
        ? record.routeId
        : null,
    };
    const input = snapshot.stops.has(record.stopId ?? "")
      ? stopObservationFromNormalized(
          sanitized,
          match?.staticTripId ?? null,
          serviceDate,
        )
      : null;
    if (!input) {
      rejected += 1;
      continue;
    }
    valid.push(input);
  }
  return { valid, rejected, unresolved };
}

export class IngestionWorker {
  private stopRequested = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly snapshot: StaticGtfsSnapshot,
    private readonly store: ObservationStore,
    private readonly clock: WorkerClock = systemClock,
  ) {}

  requestStop(): void {
    this.stopRequested = true;
  }

  private async loadFeed(): Promise<FeedPayload> {
    if (this.config.feedInputFile) {
      return {
        body: new Uint8Array(await readFile(this.config.feedInputFile)),
        status: 200,
        fetchedAt: this.clock.now(),
      };
    }

    const result = await fetchFeed(
      this.config.feedUrl,
      this.config.feedApiKey,
      this.config.requestTimeoutMs,
    );
    return {
      body: result.body,
      status: result.status,
      fetchedAt: result.fetchedAt,
    };
  }

  async runCycle(): Promise<CycleResult> {
    const startedAt = this.clock.now();
    const startedMilliseconds = Date.now();
    let payload: FeedPayload | null = null;
    let feedTimestamp: string | null = null;
    let tripUpdates = 0;
    let stopUpdates = 0;

    try {
      payload = await this.loadFeed();
      const feed = decodeFeed(payload.body);
      const tripRecords = normalizeTripUpdates(
        feed,
        this.config.feedName,
        payload.fetchedAt,
      );
      const stopRecords = normalizeStopTimeRecords(
        feed,
        this.config.feedName,
        payload.fetchedAt,
      );
      tripUpdates = tripRecords.length;
      stopUpdates = stopRecords.length;
      feedTimestamp = tripRecords.find((record) => record.feedTimestamp)?.feedTimestamp ?? null;
      if (!feedTimestamp) throw new Error("Decoded feed has no usable feed timestamp");

      const resolution = resolveRealtimeSample(
        this.snapshot,
        distinctTripRecords(tripRecords),
        this.config.serviceTimeZone,
      );
      const matches = resolvedByTrip(resolution.resolvedRecords);
      const tripInputs = buildTripInputs(
        tripRecords,
        matches,
        this.snapshot,
        resolution.serviceDate,
      );
      const stopInputs = buildStopInputs(
        stopRecords,
        matches,
        this.snapshot,
        resolution.serviceDate,
      );
      const rejectedRecords = tripInputs.rejected + stopInputs.rejected;
      const unresolvedReferenceRecords = tripInputs.unresolved + stopInputs.unresolved;
      const persistStats = await this.store.persistBatch({
        tripObservations: tripInputs.valid,
        stopTimeObservations: stopInputs.valid,
      });
      const finishedAt = this.clock.now();
      const status =
        rejectedRecords > 0 || unresolvedReferenceRecords > 0
          ? "partial"
          : "success";
      await this.store.recordIngestionRun({
        feedName: this.config.feedName,
        status,
        startedAt,
        finishedAt,
        feedTimestamp,
        fetchedAt: payload.fetchedAt,
        httpStatus: payload.status,
        bytesReceived: payload.body.byteLength,
        entitiesSeen: feed.entity.length,
        tripUpdatesSeen: tripUpdates,
        stopUpdatesSeen: stopUpdates,
        tripObservationsInserted: persistStats.tripInserted,
        stopObservationsInserted: persistStats.stopInserted,
        duplicatesIgnored: persistStats.duplicatesIgnored,
        unresolvedReferenceRecords,
        rejectedRecords,
        errorCount: 0,
        durationMs: Date.now() - startedMilliseconds,
        errorMessage: null,
      });
      return {
        status,
        tripUpdates,
        stopUpdates,
        unresolvedReferences: unresolvedReferenceRecords,
        rejectedRecords,
        persistStats,
        errorMessage: null,
      };
    } catch (error) {
      const finishedAt = this.clock.now();
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordIngestionRun({
        feedName: this.config.feedName,
        status: "failed",
        startedAt,
        finishedAt,
        feedTimestamp,
        fetchedAt: payload?.fetchedAt ?? null,
        httpStatus: payload?.status ?? null,
        bytesReceived: payload?.body.byteLength ?? 0,
        entitiesSeen: 0,
        tripUpdatesSeen: tripUpdates,
        stopUpdatesSeen: stopUpdates,
        tripObservationsInserted: 0,
        stopObservationsInserted: 0,
        duplicatesIgnored: 0,
        unresolvedReferenceRecords: 0,
        rejectedRecords: 0,
        errorCount: 1,
        durationMs: Date.now() - startedMilliseconds,
        errorMessage: message,
      });
      return {
        status: "failed",
        tripUpdates,
        stopUpdates,
        unresolvedReferences: 0,
        rejectedRecords: 0,
        persistStats: null,
        errorMessage: message,
      };
    }
  }

  async run(): Promise<CycleResult[]> {
    const results: CycleResult[] = [];
    let cycle = 0;
    while (!this.stopRequested && (this.config.maxCycles === 0 || cycle < this.config.maxCycles)) {
      results.push(await this.runCycle());
      cycle += 1;
      if (
        !this.stopRequested &&
        (this.config.maxCycles === 0 || cycle < this.config.maxCycles)
      ) {
        await this.clock.sleep(this.config.pollIntervalMs);
      }
    }
    return results;
  }
}
