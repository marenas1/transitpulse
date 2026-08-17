import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  type AnalyticsRange,
  type AnalyticsRepository,
  type QueryResult,
  type RangeWindow,
} from "./repository.js";

export type ApiServerOptions = {
  feedName: string;
  staleSeconds: number;
  minimumRankingSamples: number;
  now?: () => string;
};

type ApiMeta = {
  source: string;
  valueType: "source" | "derived";
  metricBasis: string;
  range: AnalyticsRange | null;
  sampleCount: number;
  collectionStart: string | null;
  latestObservedAt: string | null;
  freshnessSeconds: number | null;
};

function nowValue(options: ApiServerOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function rangeWindow(value: string | null, now: string): RangeWindow {
  const key = value === "7d" ? "7d" : "24h";
  const milliseconds = key === "7d" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const to = new Date(now);
  if (Number.isNaN(to.getTime())) throw new Error("Invalid API clock value");
  return {
    key,
    from: new Date(to.getTime() - milliseconds).toISOString(),
    to: to.toISOString(),
  };
}

function freshnessSeconds(observedAt: string | null, now: string): number | null {
  if (!observedAt) return null;
  const difference = new Date(now).getTime() - new Date(observedAt).getTime();
  return Math.max(0, Math.round(difference / 1000));
}

function metadata(
  query: QueryResult<unknown>,
  now: string,
  source: string,
  valueType: "source" | "derived",
  metricBasis: string,
  range: AnalyticsRange | null,
): ApiMeta {
  return {
    source,
    valueType,
    metricBasis,
    range,
    sampleCount: query.sampleCount,
    collectionStart: query.collectionStart,
    latestObservedAt: query.latestObservedAt,
    freshnessSeconds: freshnessSeconds(query.latestObservedAt, now),
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("access-control-allow-origin", "*");
  response.end(payload);
}

function errorResponse(response: ServerResponse, statusCode: number, code: string, message: string): void {
  sendJson(response, statusCode, { error: { code, message } });
}

function envelope(
  query: QueryResult<unknown>,
  now: string,
  source: string,
  valueType: "source" | "derived",
  metricBasis: string,
  range: AnalyticsRange | null,
): { data: unknown; meta: ApiMeta } {
  return {
    data: query.data,
    meta: metadata(query, now, source, valueType, metricBasis, range),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: AnalyticsRepository,
  options: ApiServerOptions,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    errorResponse(response, 405, "method_not_allowed", "TransitPulse API is read-only and accepts GET requests.");
    return;
  }

  const url = new URL(request.url ?? "/", "http://transitpulse.local");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const now = nowValue(options);

  if (path === "/health") {
    const health = await repository.getHealth();
    sendJson(response, health.status === "failed" ? 503 : 200, {
      data: health,
      meta: { source: "TransitPulse ingestion health", valueType: "source", checkedAt: now },
    });
    return;
  }

  const liveOptions = {
    staleSeconds: options.staleSeconds,
    now,
  };
  if (path === "/api/live/routes") {
    const query = await repository.getLiveRoutes(liveOptions.staleSeconds, liveOptions.now);
    sendJson(response, 200, envelope(query, now, "MTA GTFS-Realtime", "source", "latest_feed_observations", null));
    return;
  }
  if (path.startsWith("/api/live/routes/")) {
    const routeId = decodeURIComponent(path.slice("/api/live/routes/".length));
    const query = await repository.getLiveRoute(routeId, liveOptions.staleSeconds, liveOptions.now);
    if (!query.data) {
      errorResponse(response, 404, "route_not_found", `No current data is available for route ${routeId}.`);
      return;
    }
    sendJson(response, 200, envelope(query, now, "MTA GTFS-Realtime", "source", "latest_feed_observations", null));
    return;
  }
  if (path === "/api/live/stations") {
    const query = await repository.getLiveStations(liveOptions.staleSeconds, liveOptions.now);
    sendJson(response, 200, envelope(query, now, "MTA GTFS-Realtime", "source", "latest_feed_observations", null));
    return;
  }
  if (path.startsWith("/api/live/stations/")) {
    const stationId = decodeURIComponent(path.slice("/api/live/stations/".length));
    const query = await repository.getLiveStation(stationId, liveOptions.staleSeconds, liveOptions.now);
    if (!query.data) {
      errorResponse(response, 404, "station_not_found", `No current data is available for station ${stationId}.`);
      return;
    }
    sendJson(response, 200, envelope(query, now, "MTA GTFS-Realtime", "source", "latest_feed_observations", null));
    return;
  }
  if (path.startsWith("/api/live/trips/")) {
    const tripId = decodeURIComponent(path.slice("/api/live/trips/".length));
    const query = await repository.getLiveTrip(tripId, liveOptions.staleSeconds, liveOptions.now);
    if (!query.data) {
      errorResponse(response, 404, "trip_not_found", `No current data is available for trip ${tripId}.`);
      return;
    }
    sendJson(response, 200, envelope(query, now, "MTA GTFS-Realtime", "source", "latest_feed_observations", null));
    return;
  }
  if (path === "/api/live/alerts") {
    const query = await repository.getLiveAlerts(options.feedName, options.staleSeconds, now);
    sendJson(response, 200, envelope(query, now, "MTA GTFS-Realtime", "source", "latest_feed_alerts", null));
    return;
  }

  const selectedRange = rangeWindow(url.searchParams.get("range"), now);
  if (path === "/api/analytics/network") {
    const query = await repository.getNetworkAnalytics(selectedRange);
    sendJson(response, 200, envelope(query, now, "TransitPulse derived analytics", "derived", "predicted_delay_observations", selectedRange.key));
    return;
  }
  if (path.startsWith("/api/analytics/routes/")) {
    const routeId = decodeURIComponent(path.slice("/api/analytics/routes/".length));
    const query = await repository.getRouteAnalytics(routeId, selectedRange);
    if (!query.data) {
      errorResponse(response, 404, "route_not_found", `No observations are available for route ${routeId}.`);
      return;
    }
    sendJson(response, 200, envelope(query, now, "TransitPulse derived analytics", "derived", "predicted_delay_observations", selectedRange.key));
    return;
  }
  if (path.startsWith("/api/analytics/stations/")) {
    const stationId = decodeURIComponent(path.slice("/api/analytics/stations/".length));
    const query = await repository.getStationAnalytics(stationId, selectedRange);
    if (!query.data) {
      errorResponse(response, 404, "station_not_found", `No observations are available for station ${stationId}.`);
      return;
    }
    sendJson(response, 200, envelope(query, now, "TransitPulse derived analytics", "derived", "predicted_delay_observations", selectedRange.key));
    return;
  }
  if (path === "/api/rankings/routes" || path === "/api/rankings/stations") {
    const metric = url.searchParams.get("metric") ?? "avg_delay";
    if (metric !== "avg_delay") {
      errorResponse(response, 400, "unsupported_metric", "Phase 4 supports metric=avg_delay.");
      return;
    }
    const query = path.endsWith("/routes")
      ? await repository.getRouteRankings(selectedRange, options.minimumRankingSamples)
      : await repository.getStationRankings(selectedRange, options.minimumRankingSamples);
    sendJson(response, 200, {
      ...envelope(query, now, "TransitPulse derived analytics", "derived", "predicted_delay_observations", selectedRange.key),
      policy: {
        minimumSamples: options.minimumRankingSamples,
        insufficientHistory: query.data.length === 0,
      },
    });
    return;
  }

  errorResponse(response, 404, "not_found", `No TransitPulse endpoint matches ${path}.`);
}

export function createApiServer(
  repository: AnalyticsRepository,
  options: ApiServerOptions,
): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, repository, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      errorResponse(response, 500, "internal_error", message);
    });
  });
}
