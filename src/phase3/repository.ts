import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";

import type { StaticGtfsSnapshot } from "../phase2/gtfs.js";
import type { NormalizedStopTimeRecord, NormalizedTripRecord } from "../phase1/feed.js";

export type TripObservationInput = {
  feedName: string;
  sourceTripId: string;
  staticTripId: string | null;
  serviceDate: string;
  routeId: string | null;
  currentStopId: string | null;
  observedAt: string;
  feedTimestamp: string;
  ingestedAt: string;
  directionId: string | null;
  startTime: string | null;
  sourceEntityKey: string;
};

export type StopTimeObservationInput = {
  feedName: string;
  sourceTripId: string;
  staticTripId: string | null;
  serviceDate: string;
  routeId: string | null;
  stopId: string;
  observedAt: string;
  feedTimestamp: string;
  ingestedAt: string;
  scheduledArrival: string | null;
  predictedArrival: string | null;
  delaySeconds: number | null;
  stopSequence: number | null;
  sourceEntityKey: string;
};

export type PersistBatch = {
  tripObservations: TripObservationInput[];
  stopTimeObservations: StopTimeObservationInput[];
};

export type PersistStats = {
  tripCandidates: number;
  stopCandidates: number;
  tripInserted: number;
  stopInserted: number;
  duplicatesIgnored: number;
};

export type IngestionRunInput = {
  feedName: string;
  status: "success" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  feedTimestamp: string | null;
  fetchedAt: string | null;
  httpStatus: number | null;
  bytesReceived: number;
  entitiesSeen: number;
  tripUpdatesSeen: number;
  stopUpdatesSeen: number;
  tripObservationsInserted: number;
  stopObservationsInserted: number;
  duplicatesIgnored: number;
  unresolvedReferenceRecords: number;
  rejectedRecords: number;
  errorCount: number;
  durationMs: number;
  errorMessage: string | null;
};

export interface ObservationStore {
  persistBatch(batch: PersistBatch): Promise<PersistStats>;
  recordIngestionRun(run: IngestionRunInput): Promise<void>;
}

type InsertOptions = {
  conflict: string;
  returning?: string;
};

const CHUNK_SIZE = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  options: InsertOptions,
): Promise<number> {
  if (rows.length === 0) return 0;
  const values: unknown[] = [];
  const tuples = rows.map((row, rowIndex) => {
    const placeholders = row.map((value, columnIndex) => {
      values.push(value);
      return `$${rowIndex * columns.length + columnIndex + 1}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const returning = options.returning ? ` RETURNING ${options.returning}` : "";
  const result = await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}
     ${options.conflict}${returning}`,
    values,
  );
  return result.rowCount ?? 0;
}

export class PostgresObservationStore implements ObservationStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string, poolMax = 4) {
    this.pool = new Pool({ connectionString: databaseUrl, max: poolMax });
    this.pool.on("error", (error) => {
      console.error(JSON.stringify({ status: "database-pool-error", message: error.message }));
    });
  }

  async migrate(): Promise<void> {
    const migration = await readFile(
      new URL("../../db/migrations/001_phase3.sql", import.meta.url),
      "utf8",
    );
    await this.pool.query(migration);
  }

  async importStaticSnapshot(snapshot: StaticGtfsSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const batch of chunks(
        [...snapshot.routes.values()].map((route) => [
          route.routeId,
          route.shortName,
          route.longName,
          route.routeType,
          route.color,
        ]),
        CHUNK_SIZE,
      )) {
        await insertRows(
          client,
          "routes",
          ["route_id", "short_name", "long_name", "route_type", "color"],
          batch,
          {
            conflict:
              "ON CONFLICT (route_id) DO UPDATE SET short_name = EXCLUDED.short_name, long_name = EXCLUDED.long_name, route_type = EXCLUDED.route_type, color = EXCLUDED.color, updated_at = now()",
          },
        );
      }

      for (const batch of chunks(
        [...snapshot.stations.values()].map((station) => [
          station.stationId,
          station.name,
          station.latitude,
          station.longitude,
        ]),
        CHUNK_SIZE,
      )) {
        await insertRows(
          client,
          "stations",
          ["station_id", "name", "latitude", "longitude"],
          batch,
          {
            conflict:
              "ON CONFLICT (station_id) DO UPDATE SET name = EXCLUDED.name, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = now()",
          },
        );
      }

      for (const batch of chunks(
        [...snapshot.stops.values()].map((stop) => [
          stop.stopId,
          stop.stationId,
          stop.name,
          stop.latitude,
          stop.longitude,
          stop.locationType,
        ]),
        CHUNK_SIZE,
      )) {
        await insertRows(
          client,
          "stops",
          ["stop_id", "station_id", "name", "latitude", "longitude", "location_type"],
          batch,
          {
            conflict:
              "ON CONFLICT (stop_id) DO UPDATE SET station_id = EXCLUDED.station_id, name = EXCLUDED.name, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, location_type = EXCLUDED.location_type, updated_at = now()",
          },
        );
      }

      for (const batch of chunks(
        [...snapshot.trips.values()].map((trip) => [
          trip.staticTripId,
          trip.realtimeTripIdSuffix,
          trip.routeId,
          trip.serviceId,
          trip.directionId,
          trip.headsign,
        ]),
        CHUNK_SIZE,
      )) {
        await insertRows(
          client,
          "trips",
          [
            "static_trip_id",
            "realtime_trip_id_suffix",
            "route_id",
            "service_id",
            "direction_id",
            "headsign",
          ],
          batch,
          {
            conflict:
              "ON CONFLICT (static_trip_id) DO UPDATE SET realtime_trip_id_suffix = EXCLUDED.realtime_trip_id_suffix, route_id = EXCLUDED.route_id, service_id = EXCLUDED.service_id, direction_id = EXCLUDED.direction_id, headsign = EXCLUDED.headsign, updated_at = now()",
          },
        );
      }

      const scheduledRows: unknown[][] = [];
      for (const items of snapshot.scheduledStopTimesByTrip.values()) {
        for (const item of items) {
          scheduledRows.push([
            item.staticTripId,
            item.stopId,
            item.stopSequence,
            item.arrivalTime.original,
            item.departureTime.original,
            item.arrivalTime.secondsSinceServiceMidnight,
            item.departureTime.secondsSinceServiceMidnight,
          ]);
        }
      }
      for (const batch of chunks(scheduledRows, CHUNK_SIZE)) {
        await insertRows(
          client,
          "scheduled_stop_times",
          [
            "static_trip_id",
            "stop_id",
            "stop_sequence",
            "arrival_time",
            "departure_time",
            "arrival_seconds",
            "departure_seconds",
          ],
          batch,
          {
            conflict:
              "ON CONFLICT (static_trip_id, stop_id, stop_sequence) DO UPDATE SET arrival_time = EXCLUDED.arrival_time, departure_time = EXCLUDED.departure_time, arrival_seconds = EXCLUDED.arrival_seconds, departure_seconds = EXCLUDED.departure_seconds",
          },
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistBatch(batch: PersistBatch): Promise<PersistStats> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let tripInserted = 0;
      let stopInserted = 0;

      for (const group of chunks(batch.tripObservations, CHUNK_SIZE)) {
        tripInserted += await insertRows(
          client,
          "trip_observations",
          [
            "feed_name",
            "source_trip_id",
            "static_trip_id",
            "service_date",
            "route_id",
            "current_stop_id",
            "observed_at",
            "feed_timestamp",
            "ingested_at",
            "direction_id",
            "start_time",
            "source_entity_key",
          ],
          group.map((row) => [
            row.feedName,
            row.sourceTripId,
            row.staticTripId,
            row.serviceDate,
            row.routeId,
            row.currentStopId,
            row.observedAt,
            row.feedTimestamp,
            row.ingestedAt,
            row.directionId,
            row.startTime,
            row.sourceEntityKey,
          ]),
          { conflict: "ON CONFLICT DO NOTHING", returning: "id" },
        );
      }

      for (const group of chunks(batch.stopTimeObservations, CHUNK_SIZE)) {
        stopInserted += await insertRows(
          client,
          "stop_time_observations",
          [
            "feed_name",
            "source_trip_id",
            "static_trip_id",
            "service_date",
            "route_id",
            "stop_id",
            "observed_at",
            "feed_timestamp",
            "ingested_at",
            "scheduled_arrival",
            "predicted_arrival",
            "delay_seconds",
            "stop_sequence",
            "source_entity_key",
          ],
          group.map((row) => [
            row.feedName,
            row.sourceTripId,
            row.staticTripId,
            row.serviceDate,
            row.routeId,
            row.stopId,
            row.observedAt,
            row.feedTimestamp,
            row.ingestedAt,
            row.scheduledArrival,
            row.predictedArrival,
            row.delaySeconds,
            row.stopSequence,
            row.sourceEntityKey,
          ]),
          { conflict: "ON CONFLICT DO NOTHING", returning: "id" },
        );
      }

      await client.query("COMMIT");
      const totalCandidates = batch.tripObservations.length + batch.stopTimeObservations.length;
      return {
        tripCandidates: batch.tripObservations.length,
        stopCandidates: batch.stopTimeObservations.length,
        tripInserted,
        stopInserted,
        duplicatesIgnored: totalCandidates - tripInserted - stopInserted,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordIngestionRun(run: IngestionRunInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_runs (
        feed_name, status, started_at, finished_at, feed_timestamp, fetched_at,
        http_status, bytes_received, entities_seen, trip_updates_seen,
        stop_updates_seen, trip_observations_inserted, stop_observations_inserted,
        duplicates_ignored, unresolved_reference_records, rejected_records,
        error_count, duration_ms, error_message
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      )`,
      [
        run.feedName,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.feedTimestamp,
        run.fetchedAt,
        run.httpStatus,
        run.bytesReceived,
        run.entitiesSeen,
        run.tripUpdatesSeen,
        run.stopUpdatesSeen,
        run.tripObservationsInserted,
        run.stopObservationsInserted,
        run.duplicatesIgnored,
        run.unresolvedReferenceRecords,
        run.rejectedRecords,
        run.errorCount,
        run.durationMs,
        run.errorMessage,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function tripObservationFromNormalized(
  record: NormalizedTripRecord,
  staticTripId: string | null,
  serviceDate: string,
): TripObservationInput {
  if (!record.feedTimestamp) throw new Error("Trip record has no feed timestamp");
  return {
    feedName: record.feedName,
    sourceTripId: record.tripId,
    staticTripId,
    serviceDate,
    routeId: record.routeId,
    currentStopId: record.stopId,
    observedAt: record.observedAt,
    feedTimestamp: record.feedTimestamp,
    ingestedAt: record.observedAt,
    directionId: record.directionId,
    startTime: record.startTime,
    sourceEntityKey: record.tripId,
  };
}

export function stopObservationFromNormalized(
  record: NormalizedStopTimeRecord,
  staticTripId: string | null,
  serviceDate: string,
): StopTimeObservationInput | null {
  if (!record.feedTimestamp || !record.stopId) return null;
  return {
    feedName: record.feedName,
    sourceTripId: record.tripId,
    staticTripId,
    serviceDate,
    routeId: record.routeId,
    stopId: record.stopId,
    observedAt: record.observedAt,
    feedTimestamp: record.feedTimestamp,
    ingestedAt: record.observedAt,
    scheduledArrival: record.scheduledArrival,
    predictedArrival: record.predictedArrival,
    delaySeconds: record.delaySeconds,
    stopSequence: record.stopSequence,
    sourceEntityKey: `${record.tripId}:${record.stopId}:${record.stopSequence ?? "unknown"}`,
  };
}
