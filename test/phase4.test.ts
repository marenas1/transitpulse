import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createApiServer,
  LATE_THRESHOLD_SECONDS,
  rankSamples,
  summarizeSamples,
  type AnalyticsRepository,
  type HealthStatus,
  type LiveAlert,
  type LiveRoute,
  type LiveStation,
  type LiveTrip,
  type NetworkAnalytics,
  type QueryResult,
  type RankedMetric,
  type RouteAnalytics,
  type StationAnalytics,
} from "../src/phase4/index.js";

function query<T>(data: T, observedAt: string[] = []): QueryResult<T> {
  const sorted = [...observedAt].sort();
  return {
    data,
    sampleCount: observedAt.length,
    collectionStart: sorted[0] ?? null,
    latestObservedAt: sorted.at(-1) ?? null,
    aggregateUpdatedAt: null,
  };
}

class FakeAnalyticsRepository implements AnalyticsRepository {
  readonly network: QueryResult<NetworkAnalytics>;
  readonly rankings: QueryResult<RankedMetric[]>;

  constructor() {
    this.network = query(
      {
        metrics: summarizeSamples([
          { entityId: "network", entityName: "NYC Subway", observedAt: "2026-08-17T12:00:00.000Z", delaySeconds: 60 },
          { entityId: "network", entityName: "NYC Subway", observedAt: "2026-08-17T12:01:00.000Z", delaySeconds: 180 },
          { entityId: "network", entityName: "NYC Subway", observedAt: "2026-08-17T12:02:00.000Z", delaySeconds: null },
          { entityId: "network", entityName: "NYC Subway", observedAt: "2026-08-17T12:03:00.000Z", delaySeconds: 600 },
        ]),
        routes: [],
        stations: [],
      },
      ["2026-08-17T12:00:00.000Z", "2026-08-17T12:01:00.000Z", "2026-08-17T12:02:00.000Z", "2026-08-17T12:03:00.000Z"],
    );
    this.rankings = query([
      {
        rank: 1,
        entityId: "A",
        entityName: "A",
        metrics: summarizeSamples(
          Array.from({ length: 100 }, (_, index) => ({
            entityId: "A",
            entityName: "A",
            observedAt: `2026-08-17T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
            delaySeconds: 600,
          })),
          100,
        ),
      },
    ], ["2026-08-17T12:00:00.000Z"]);
  }

  async getHealth(): Promise<HealthStatus> {
    return { status: "healthy", latestRun: null };
  }
  async getLiveRoutes(): Promise<QueryResult<LiveRoute[]>> { return query([]); }
  async getLiveRoute(): Promise<QueryResult<LiveRoute | null>> { return query(null); }
  async getLiveStations(): Promise<QueryResult<LiveStation[]>> { return query([]); }
  async getLiveStation(): Promise<QueryResult<LiveStation | null>> { return query(null); }
  async getLiveTrip(): Promise<QueryResult<LiveTrip | null>> { return query(null); }
  async getLiveAlerts(): Promise<QueryResult<LiveAlert[]>> { return query([]); }
  async getNetworkAnalytics(): Promise<QueryResult<NetworkAnalytics>> { return this.network; }
  async getRouteAnalytics(): Promise<QueryResult<RouteAnalytics | null>> { return query(null); }
  async getStationAnalytics(): Promise<QueryResult<StationAnalytics | null>> { return query(null); }
  async getRouteRankings(): Promise<QueryResult<RankedMetric[]>> { return this.rankings; }
  async getStationRankings(): Promise<QueryResult<RankedMetric[]>> { return query([]); }
  async refreshDailyAggregates(): Promise<void> {}
  async close(): Promise<void> {}
}

test("calculates delay metrics without turning missing values into zero", () => {
  const metrics = summarizeSamples([
    { entityId: "route-a", entityName: "A", observedAt: "2026-08-17T12:00:00.000Z", delaySeconds: 60 },
    { entityId: "route-a", entityName: "A", observedAt: "2026-08-17T12:01:00.000Z", delaySeconds: 180 },
    { entityId: "route-a", entityName: "A", observedAt: "2026-08-17T12:02:00.000Z", delaySeconds: 300 },
    { entityId: "route-a", entityName: "A", observedAt: "2026-08-17T12:03:00.000Z", delaySeconds: 600 },
    { entityId: "route-a", entityName: "A", observedAt: "2026-08-17T12:04:00.000Z", delaySeconds: null },
  ]);

  assert.equal(LATE_THRESHOLD_SECONDS, 300);
  assert.equal(metrics.observationCount, 5);
  assert.equal(metrics.delaySampleCount, 4);
  assert.equal(metrics.averageDelaySeconds, 285);
  assert.equal(metrics.medianDelaySeconds, 240);
  assert.equal(metrics.p95DelaySeconds, 555);
  assert.equal(metrics.lateObservationCount, 2);
  assert.equal(metrics.lateRate, 0.5);
});

test("requires the evidence threshold before ranking an entity", () => {
  const samples = [
    ...Array.from({ length: 100 }, (_, index) => ({
      entityId: "A",
      entityName: "A",
      observedAt: `2026-08-17T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      delaySeconds: 600,
    })),
    ...Array.from({ length: 99 }, (_, index) => ({
      entityId: "B",
      entityName: "B",
      observedAt: `2026-08-17T13:${String(index % 60).padStart(2, "0")}:00.000Z`,
      delaySeconds: 60,
    })),
  ];
  const rankings = rankSamples(samples, 100);
  assert.deepEqual(rankings.map((item) => item.entityId), ["A"]);
  assert.equal(summarizeSamples(samples.slice(0, 99), 100).status, "insufficient_history");
});

test("API distinguishes derived analytics from live source state", async () => {
  const repository = new FakeAnalyticsRepository();
  const server = createApiServer(repository, {
    feedName: "fixture",
    staleSeconds: 60,
    minimumRankingSamples: 100,
    now: () => "2026-08-17T13:00:00.000Z",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const analyticsResponse = await fetch(`${base}/api/analytics/network?range=7d`);
    assert.equal(analyticsResponse.status, 200);
    const analytics = await analyticsResponse.json() as {
      data: { metrics: { averageDelaySeconds: number; delaySampleCount: number; lateRate: number } };
      meta: { valueType: string; range: string; sampleCount: number; metricBasis: string };
    };
    assert.equal(analytics.data.metrics.averageDelaySeconds, 280);
    assert.equal(analytics.data.metrics.delaySampleCount, 3);
    assert.equal(analytics.data.metrics.lateRate, 0.33);
    assert.equal(analytics.meta.valueType, "derived");
    assert.equal(analytics.meta.range, "7d");
    assert.equal(analytics.meta.sampleCount, 4);
    assert.equal(analytics.meta.metricBasis, "predicted_delay_observations");

    const rankingResponse = await fetch(`${base}/api/rankings/routes?metric=avg_delay`);
    assert.equal(rankingResponse.status, 200);
    const ranking = await rankingResponse.json() as { data: RankedMetric[]; policy: { minimumSamples: number } };
    assert.equal(ranking.data[0]?.entityId, "A");
    assert.equal(ranking.policy.minimumSamples, 100);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
