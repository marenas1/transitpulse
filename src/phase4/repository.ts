import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import {
  DEFAULT_MINIMUM_RANKING_SAMPLES,
  groupSamples,
  rankSamples,
  summarizeSamples,
  type MetricSample,
  type MetricSummary,
  type RankedMetric,
} from "./metrics.js";

export type AnalyticsRange = "24h" | "7d";

export type RangeWindow = {
  key: AnalyticsRange;
  from: string;
  to: string;
};

export type QueryResult<T> = {
  data: T;
  sampleCount: number;
  collectionStart: string | null;
  latestObservedAt: string | null;
  aggregateUpdatedAt: string | null;
};

export type LiveRoute = {
  routeId: string;
  shortName: string;
  longName: string;
  activeTripCount: number;
  currentAverageDelaySeconds: number | null;
  latestObservedAt: string | null;
};

export type LiveStation = {
  stationId: string;
  name: string;
  incomingTripCount: number;
  currentAverageDelaySeconds: number | null;
  nextPredictedArrival: string | null;
  latestObservedAt: string | null;
};

export type LiveTrip = {
  tripId: string;
  staticTripId: string | null;
  routeId: string | null;
  routeName: string | null;
  currentStopId: string | null;
  observedAt: string;
  stops: Array<{
    stopId: string;
    stopName: string;
    stopSequence: number | null;
    predictedArrival: string | null;
    delaySeconds: number | null;
    observedAt: string;
  }>;
};

export type LiveAlert = {
  alertId: string;
  headerText: string;
  descriptionText: string | null;
  cause: string | null;
  effect: string | null;
  routeIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
};

export type AnalyticsEntity = {
  entityId: string;
  entityName: string;
  metrics: MetricSummary;
};

export type NetworkAnalytics = {
  metrics: MetricSummary;
  routes: AnalyticsEntity[];
  stations: AnalyticsEntity[];
};

export type RouteAnalytics = AnalyticsEntity & {
  byStation: AnalyticsEntity[];
};

export type StationAnalytics = AnalyticsEntity & {
  byRoute: AnalyticsEntity[];
};

export type HealthStatus = {
  status: "healthy" | "degraded" | "failed" | "unknown";
  latestRun: {
    status: string;
    finishedAt: string;
    durationMs: number;
    rejectedRecords: number;
    unresolvedReferenceRecords: number;
    errorMessage: string | null;
  } | null;
};

type MetricRow = {
  routeId: string | null;
  routeName: string | null;
  stationId: string | null;
  stationName: string | null;
  observedAt: string;
  delaySeconds: number | null;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asInteger(value: unknown): number {
  return Math.trunc(Number(value) || 0);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

function result<T>(data: T, observedAt: string[]): QueryResult<T> {
  const sorted = observedAt.filter(Boolean).sort();
  return {
    data,
    sampleCount: observedAt.length,
    collectionStart: sorted[0] ?? null,
    latestObservedAt: sorted.at(-1) ?? null,
    aggregateUpdatedAt: null,
  };
}

function entitySamples(
  rows: MetricRow[],
  id: "routeId" | "stationId",
  name: "routeName" | "stationName",
): Map<string, { entityName: string; samples: MetricSample[] }> {
  return groupSamples(
    rows
      .filter((row) => row[id] !== null)
      .map((row) => ({
        entityId: row[id] as string,
        entityName: row[name] ?? row[id] as string,
        observedAt: row.observedAt,
        delaySeconds: row.delaySeconds,
      })),
  );
}

function entityList(
  rows: MetricRow[],
  id: "routeId" | "stationId",
  name: "routeName" | "stationName",
  minimumSamples = 1,
): AnalyticsEntity[] {
  return [...entitySamples(rows, id, name).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId, group]) => ({
      entityId,
      entityName: group.entityName,
      metrics: summarizeSamples(group.samples, minimumSamples),
    }));
}

function rankedEntityList(
  rows: MetricRow[],
  id: "routeId" | "stationId",
  name: "routeName" | "stationName",
  minimumSamples: number,
): RankedMetric[] {
  return rankSamples(
    rows
      .filter((row) => row[id] !== null)
      .map((row) => ({
        entityId: row[id] as string,
        entityName: row[name] ?? row[id] as string,
        observedAt: row.observedAt,
        delaySeconds: row.delaySeconds,
      })),
    minimumSamples,
  );
}

export interface AnalyticsRepository {
  getHealth(): Promise<HealthStatus>;
  getLiveRoutes(staleSeconds: number, now: string): Promise<QueryResult<LiveRoute[]>>;
  getLiveRoute(routeId: string, staleSeconds: number, now: string): Promise<QueryResult<LiveRoute | null>>;
  getLiveStations(staleSeconds: number, now: string): Promise<QueryResult<LiveStation[]>>;
  getLiveStation(stationId: string, staleSeconds: number, now: string): Promise<QueryResult<LiveStation | null>>;
  getLiveTrip(tripId: string, staleSeconds: number, now: string): Promise<QueryResult<LiveTrip | null>>;
  getLiveAlerts(feedName: string, staleSeconds: number, now: string): Promise<QueryResult<LiveAlert[]>>;
  getNetworkAnalytics(window: RangeWindow): Promise<QueryResult<NetworkAnalytics>>;
  getRouteAnalytics(routeId: string, window: RangeWindow): Promise<QueryResult<RouteAnalytics | null>>;
  getStationAnalytics(stationId: string, window: RangeWindow): Promise<QueryResult<StationAnalytics | null>>;
  getRouteRankings(window: RangeWindow, minimumSamples?: number): Promise<QueryResult<RankedMetric[]>>;
  getStationRankings(window: RangeWindow, minimumSamples?: number): Promise<QueryResult<RankedMetric[]>>;
  refreshDailyAggregates(fromDate: string, toDate: string): Promise<void>;
  close(): Promise<void>;
}

export class PostgresAnalyticsRepository implements AnalyticsRepository {
  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly serviceTimeZone: string,
    poolMax = 4,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl, max: poolMax });
    this.pool.on("error", (error) => {
      console.error(JSON.stringify({ status: "analytics-database-pool-error", message: error.message }));
    });
  }

  async migrate(): Promise<void> {
    for (const filename of ["001_phase3.sql", "002_phase4.sql"]) {
      const migration = await readFile(
        new URL(`../../db/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await this.pool.query(migration);
    }
  }

  private async metricRows(window: RangeWindow, routeId?: string, stationId?: string): Promise<MetricRow[]> {
    const rows = await this.pool.query(
      `WITH scheduled AS (
        SELECT
          o.id,
          COALESCE(o.route_id, t.route_id) AS route_id,
          o.stop_id,
          o.observed_at,
          o.predicted_arrival,
          o.delay_seconds,
          o.service_date,
          o.static_trip_id,
          o.stop_sequence,
          sst.arrival_seconds,
          r.short_name AS route_name,
          s.station_id,
          st.name AS station_name
        FROM stop_time_observations o
        LEFT JOIN scheduled_stop_times sst
          ON sst.static_trip_id = o.static_trip_id
         AND sst.stop_id = o.stop_id
         AND sst.stop_sequence = o.stop_sequence
        LEFT JOIN trips t ON t.static_trip_id = o.static_trip_id
        LEFT JOIN routes r ON r.route_id = COALESCE(o.route_id, t.route_id)
        LEFT JOIN stops s ON s.stop_id = o.stop_id
        LEFT JOIN stations st ON st.station_id = s.station_id
        WHERE o.observed_at >= $1
          AND o.observed_at < $2
          AND ($4::text IS NULL OR COALESCE(o.route_id, t.route_id) = $4)
          AND ($5::text IS NULL OR st.station_id = $5)
      )
      SELECT
        route_id,
        route_name,
        station_id,
        station_name,
        observed_at,
        COALESCE(
          delay_seconds,
          CASE
            WHEN predicted_arrival IS NOT NULL AND arrival_seconds IS NOT NULL
            THEN EXTRACT(EPOCH FROM (
              predicted_arrival -
              ((service_date::timestamp AT TIME ZONE $3) + arrival_seconds * interval '1 second')
            ))::integer
          END
        ) AS delay_seconds
      FROM scheduled
      ORDER BY observed_at ASC, id ASC`,
      [window.from, window.to, this.serviceTimeZone, routeId ?? null, stationId ?? null],
    );
    return rows.rows.map((row) => ({
      routeId: asString(row.route_id),
      routeName: asString(row.route_name),
      stationId: asString(row.station_id),
      stationName: asString(row.station_name),
      observedAt: new Date(row.observed_at).toISOString(),
      delaySeconds: asNumber(row.delay_seconds),
    }));
  }

  private async liveRouteRows(routeId: string | null, staleSeconds: number, now: string): Promise<LiveRoute[]> {
    const rows = await this.pool.query(
      `WITH latest_trips AS (
        SELECT DISTINCT ON (source_trip_id)
          source_trip_id, route_id, observed_at
        FROM trip_observations
        WHERE observed_at >= $1::timestamptz - ($2::integer * interval '1 second')
          AND ($3::text IS NULL OR route_id = $3)
        ORDER BY source_trip_id, observed_at DESC, id DESC
      ), latest_delays AS (
        SELECT DISTINCT ON (source_trip_id, stop_id)
          source_trip_id, delay_seconds, observed_at
        FROM stop_time_observations
        WHERE observed_at >= $1::timestamptz - ($2::integer * interval '1 second')
        ORDER BY source_trip_id, stop_id, observed_at DESC, id DESC
      )
      SELECT
        r.route_id,
        r.short_name,
        r.long_name,
        count(DISTINCT t.source_trip_id)::integer AS active_trip_count,
        avg(d.delay_seconds)::double precision AS current_average_delay_seconds,
        max(GREATEST(t.observed_at, d.observed_at)) AS latest_observed_at
      FROM latest_trips t
      JOIN routes r ON r.route_id = t.route_id
      LEFT JOIN latest_delays d ON d.source_trip_id = t.source_trip_id
      GROUP BY r.route_id, r.short_name, r.long_name
      ORDER BY r.short_name`,
      [now, staleSeconds, routeId],
    );
    return rows.rows.map((row) => ({
      routeId: String(row.route_id),
      shortName: String(row.short_name),
      longName: String(row.long_name),
      activeTripCount: asInteger(row.active_trip_count),
      currentAverageDelaySeconds: asNumber(row.current_average_delay_seconds),
      latestObservedAt: row.latest_observed_at ? new Date(row.latest_observed_at).toISOString() : null,
    }));
  }

  async getHealth(): Promise<HealthStatus> {
    const result = await this.pool.query(
      `SELECT status, finished_at, duration_ms, rejected_records,
              unresolved_reference_records, error_message
       FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return { status: "unknown", latestRun: null };
    const latestRun = {
      status: String(row.status),
      finishedAt: new Date(row.finished_at).toISOString(),
      durationMs: asInteger(row.duration_ms),
      rejectedRecords: asInteger(row.rejected_records),
      unresolvedReferenceRecords: asInteger(row.unresolved_reference_records),
      errorMessage: asString(row.error_message),
    };
    return {
      status: latestRun.status === "failed" ? "failed" : latestRun.status === "partial" ? "degraded" : "healthy",
      latestRun,
    };
  }

  async getLiveRoutes(staleSeconds: number, now: string): Promise<QueryResult<LiveRoute[]>> {
    const data = await this.liveRouteRows(null, staleSeconds, now);
    return result(data, data.flatMap((row) => row.latestObservedAt ? [row.latestObservedAt] : []));
  }

  async getLiveRoute(routeId: string, staleSeconds: number, now: string): Promise<QueryResult<LiveRoute | null>> {
    const data = await this.liveRouteRows(routeId, staleSeconds, now);
    const route = data[0] ?? null;
    return result(route, route?.latestObservedAt ? [route.latestObservedAt] : []);
  }

  private async liveStationRows(stationId: string | null, staleSeconds: number, now: string): Promise<LiveStation[]> {
    const rows = await this.pool.query(
      `WITH latest AS (
        SELECT DISTINCT ON (source_trip_id, stop_id)
          source_trip_id, stop_id, predicted_arrival, delay_seconds, observed_at
        FROM stop_time_observations
        WHERE observed_at >= $1::timestamptz - ($2::integer * interval '1 second')
        ORDER BY source_trip_id, stop_id, observed_at DESC, id DESC
      )
      SELECT
        st.station_id,
        st.name,
        count(DISTINCT latest.source_trip_id)::integer AS incoming_trip_count,
        avg(latest.delay_seconds)::double precision AS current_average_delay_seconds,
        min(latest.predicted_arrival) AS next_predicted_arrival,
        max(latest.observed_at) AS latest_observed_at
      FROM latest
      JOIN stops s ON s.stop_id = latest.stop_id
      JOIN stations st ON st.station_id = s.station_id
      WHERE ($3::text IS NULL OR st.station_id = $3)
      GROUP BY st.station_id, st.name
      ORDER BY st.name`,
      [now, staleSeconds, stationId],
    );
    return rows.rows.map((row) => ({
      stationId: String(row.station_id),
      name: String(row.name),
      incomingTripCount: asInteger(row.incoming_trip_count),
      currentAverageDelaySeconds: asNumber(row.current_average_delay_seconds),
      nextPredictedArrival: row.next_predicted_arrival ? new Date(row.next_predicted_arrival).toISOString() : null,
      latestObservedAt: row.latest_observed_at ? new Date(row.latest_observed_at).toISOString() : null,
    }));
  }

  async getLiveStations(staleSeconds: number, now: string): Promise<QueryResult<LiveStation[]>> {
    const data = await this.liveStationRows(null, staleSeconds, now);
    return result(data, data.flatMap((row) => row.latestObservedAt ? [row.latestObservedAt] : []));
  }

  async getLiveStation(stationId: string, staleSeconds: number, now: string): Promise<QueryResult<LiveStation | null>> {
    const data = await this.liveStationRows(stationId, staleSeconds, now);
    const station = data[0] ?? null;
    return result(station, station?.latestObservedAt ? [station.latestObservedAt] : []);
  }

  async getLiveTrip(tripId: string, staleSeconds: number, now: string): Promise<QueryResult<LiveTrip | null>> {
    const tripResult = await this.pool.query(
      `SELECT DISTINCT ON (o.source_trip_id)
          o.source_trip_id, o.static_trip_id, o.route_id, r.short_name AS route_name,
          o.current_stop_id, o.observed_at
       FROM trip_observations o
       LEFT JOIN routes r ON r.route_id = o.route_id
       WHERE o.source_trip_id = $1
         AND o.observed_at >= $2::timestamptz - ($3::integer * interval '1 second')
       ORDER BY o.source_trip_id, o.observed_at DESC, o.id DESC`,
      [tripId, now, staleSeconds],
    );
    const tripRow = tripResult.rows[0];
    if (!tripRow) return result(null, []);
    const stopResult = await this.pool.query(
      `SELECT DISTINCT ON (o.stop_id)
          o.stop_id, s.name AS stop_name, o.stop_sequence, o.predicted_arrival,
          o.delay_seconds, o.observed_at
       FROM stop_time_observations o
       JOIN stops s ON s.stop_id = o.stop_id
       WHERE o.source_trip_id = $1
         AND o.observed_at >= $2::timestamptz - ($3::integer * interval '1 second')
       ORDER BY o.stop_id, o.observed_at DESC, o.id DESC`,
      [tripId, now, staleSeconds],
    );
    const data: LiveTrip = {
      tripId: String(tripRow.source_trip_id),
      staticTripId: asString(tripRow.static_trip_id),
      routeId: asString(tripRow.route_id),
      routeName: asString(tripRow.route_name),
      currentStopId: asString(tripRow.current_stop_id),
      observedAt: new Date(tripRow.observed_at).toISOString(),
      stops: stopResult.rows.map((row) => ({
        stopId: String(row.stop_id),
        stopName: String(row.stop_name),
        stopSequence: asNumber(row.stop_sequence),
        predictedArrival: row.predicted_arrival ? new Date(row.predicted_arrival).toISOString() : null,
        delaySeconds: asNumber(row.delay_seconds),
        observedAt: new Date(row.observed_at).toISOString(),
      })),
    };
    return result(data, [data.observedAt, ...data.stops.map((stop) => stop.observedAt)]);
  }

  async getLiveAlerts(feedName: string, staleSeconds: number, now: string): Promise<QueryResult<LiveAlert[]>> {
    const rows = await this.pool.query(
      `SELECT
          a.alert_id, a.header_text, a.description_text, a.cause, a.effect,
          a.first_seen_at, a.last_seen_at,
          COALESCE(array_agg(ar.route_id) FILTER (WHERE ar.route_id IS NOT NULL), '{}') AS route_ids
       FROM service_alerts a
       LEFT JOIN alert_routes ar
         ON ar.feed_name = a.feed_name AND ar.alert_id = a.alert_id
       WHERE a.feed_name = $1
         AND a.last_seen_at >= $2::timestamptz - ($3::integer * interval '1 second')
       GROUP BY a.alert_id, a.header_text, a.description_text, a.cause, a.effect,
                a.first_seen_at, a.last_seen_at
       ORDER BY a.last_seen_at DESC`,
      [feedName, now, staleSeconds],
    );
    const data = rows.rows.map((row) => ({
      alertId: String(row.alert_id),
      headerText: String(row.header_text),
      descriptionText: asString(row.description_text),
      cause: asString(row.cause),
      effect: asString(row.effect),
      routeIds: Array.isArray(row.route_ids) ? row.route_ids.map(String) : [],
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    }));
    return result(data, data.map((row) => row.lastSeenAt));
  }

  private async analyticsRows(window: RangeWindow, routeId?: string, stationId?: string): Promise<MetricRow[]> {
    return this.metricRows(window, routeId, stationId);
  }

  async getNetworkAnalytics(window: RangeWindow): Promise<QueryResult<NetworkAnalytics>> {
    const rows = await this.analyticsRows(window);
    const samples = rows.map((row) => ({
      entityId: "network",
      entityName: "NYC Subway",
      observedAt: row.observedAt,
      delaySeconds: row.delaySeconds,
    }));
    return {
      ...result(
        {
          metrics: summarizeSamples(samples),
          routes: entityList(rows, "routeId", "routeName"),
          stations: entityList(rows, "stationId", "stationName"),
        },
        rows.map((row) => row.observedAt),
      ),
    };
  }

  async getRouteAnalytics(routeId: string, window: RangeWindow): Promise<QueryResult<RouteAnalytics | null>> {
    const rows = await this.analyticsRows(window, routeId);
    const routeRows = rows.filter((row) => row.routeId === routeId);
    if (routeRows.length === 0) return result(null, []);
    const routeName = routeRows.find((row) => row.routeName)?.routeName ?? routeId;
    return result(
      {
        entityId: routeId,
        entityName: routeName,
        metrics: summarizeSamples(routeRows.map((row) => ({
          entityId: routeId,
          entityName: routeName,
          observedAt: row.observedAt,
          delaySeconds: row.delaySeconds,
        }))),
        byStation: entityList(routeRows, "stationId", "stationName"),
      },
      routeRows.map((row) => row.observedAt),
    );
  }

  async getStationAnalytics(stationId: string, window: RangeWindow): Promise<QueryResult<StationAnalytics | null>> {
    const rows = await this.analyticsRows(window, undefined, stationId);
    const stationRows = rows.filter((row) => row.stationId === stationId);
    if (stationRows.length === 0) return result(null, []);
    const stationName = stationRows.find((row) => row.stationName)?.stationName ?? stationId;
    return result(
      {
        entityId: stationId,
        entityName: stationName,
        metrics: summarizeSamples(stationRows.map((row) => ({
          entityId: stationId,
          entityName: stationName,
          observedAt: row.observedAt,
          delaySeconds: row.delaySeconds,
        }))),
        byRoute: entityList(stationRows, "routeId", "routeName"),
      },
      stationRows.map((row) => row.observedAt),
    );
  }

  async getRouteRankings(window: RangeWindow, minimumSamples = DEFAULT_MINIMUM_RANKING_SAMPLES): Promise<QueryResult<RankedMetric[]>> {
    const rows = await this.analyticsRows(window);
    return result(rankedEntityList(rows, "routeId", "routeName", minimumSamples), rows.map((row) => row.observedAt));
  }

  async getStationRankings(window: RangeWindow, minimumSamples = DEFAULT_MINIMUM_RANKING_SAMPLES): Promise<QueryResult<RankedMetric[]>> {
    const rows = await this.analyticsRows(window);
    return result(rankedEntityList(rows, "stationId", "stationName", minimumSamples), rows.map((row) => row.observedAt));
  }

  async refreshDailyAggregates(fromDate: string, toDate: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const params = [fromDate, toDate, this.serviceTimeZone];
      const common = `
        WITH samples AS (
          SELECT
            COALESCE(o.route_id, t.route_id) AS route_id,
            st.station_id,
            (o.observed_at AT TIME ZONE $3)::date AS metric_date,
            COALESCE(
              o.delay_seconds,
              CASE
                WHEN o.predicted_arrival IS NOT NULL AND sst.arrival_seconds IS NOT NULL
                THEN EXTRACT(EPOCH FROM (
                  o.predicted_arrival -
                  ((o.service_date::timestamp AT TIME ZONE $3) + sst.arrival_seconds * interval '1 second')
                ))::integer
              END
            ) AS delay_seconds
          FROM stop_time_observations o
          LEFT JOIN scheduled_stop_times sst
            ON sst.static_trip_id = o.static_trip_id
           AND sst.stop_id = o.stop_id
           AND sst.stop_sequence = o.stop_sequence
          LEFT JOIN trips t ON t.static_trip_id = o.static_trip_id
          LEFT JOIN stops s ON s.stop_id = o.stop_id
          LEFT JOIN stations st ON st.station_id = s.station_id
          WHERE (o.observed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        ),
        enriched AS (
          SELECT route_id, station_id, metric_date, delay_seconds
          FROM samples
        )`;
      await client.query(
        `${common}
        INSERT INTO route_daily_metrics (
          metric_date, route_id, observation_count, delay_sample_count,
          late_observation_count, average_delay_seconds, median_delay_seconds,
          p95_delay_seconds, late_rate, aggregate_updated_at
        )
        SELECT metric_date, route_id, count(*)::integer,
          count(delay_seconds)::integer,
          count(*) FILTER (WHERE delay_seconds >= 300)::integer,
          avg(delay_seconds), percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_seconds),
          percentile_cont(0.95) WITHIN GROUP (ORDER BY delay_seconds),
          count(*) FILTER (WHERE delay_seconds >= 300)::numeric / NULLIF(count(delay_seconds), 0),
          now()
        FROM enriched
        WHERE route_id IS NOT NULL
        GROUP BY metric_date, route_id
        ON CONFLICT (metric_date, route_id) DO UPDATE SET
          observation_count = EXCLUDED.observation_count,
          delay_sample_count = EXCLUDED.delay_sample_count,
          late_observation_count = EXCLUDED.late_observation_count,
          average_delay_seconds = EXCLUDED.average_delay_seconds,
          median_delay_seconds = EXCLUDED.median_delay_seconds,
          p95_delay_seconds = EXCLUDED.p95_delay_seconds,
          late_rate = EXCLUDED.late_rate,
          aggregate_updated_at = EXCLUDED.aggregate_updated_at`,
        params,
      );
      await client.query(
        `${common}
        INSERT INTO station_daily_metrics (
          metric_date, station_id, observation_count, delay_sample_count,
          late_observation_count, average_delay_seconds, median_delay_seconds,
          p95_delay_seconds, late_rate, aggregate_updated_at
        )
        SELECT metric_date, station_id, count(*)::integer,
          count(delay_seconds)::integer,
          count(*) FILTER (WHERE delay_seconds >= 300)::integer,
          avg(delay_seconds), percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_seconds),
          percentile_cont(0.95) WITHIN GROUP (ORDER BY delay_seconds),
          count(*) FILTER (WHERE delay_seconds >= 300)::numeric / NULLIF(count(delay_seconds), 0),
          now()
        FROM enriched
        WHERE station_id IS NOT NULL
        GROUP BY metric_date, station_id
        ON CONFLICT (metric_date, station_id) DO UPDATE SET
          observation_count = EXCLUDED.observation_count,
          delay_sample_count = EXCLUDED.delay_sample_count,
          late_observation_count = EXCLUDED.late_observation_count,
          average_delay_seconds = EXCLUDED.average_delay_seconds,
          median_delay_seconds = EXCLUDED.median_delay_seconds,
          p95_delay_seconds = EXCLUDED.p95_delay_seconds,
          late_rate = EXCLUDED.late_rate,
          aggregate_updated_at = EXCLUDED.aggregate_updated_at`,
        params,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
