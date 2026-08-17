import GtfsRealtimeBindings from "gtfs-realtime-bindings";

type UnknownRecord = Record<string, unknown>;

export type NormalizedTripRecord = {
  feedName: string;
  feedTimestamp: string | null;
  observedAt: string;
  routeId: string | null;
  tripId: string;
  directionId: string | null;
  startTime: string | null;
  stopId: string | null;
  scheduledArrival: string | null;
  predictedArrival: string | null;
  delaySeconds: number | null;
};

export type NormalizedStopTimeRecord = NormalizedTripRecord & {
  stopSequence: number | null;
};

export type NormalizedAlertRecord = {
  feedName: string;
  alertId: string;
  feedTimestamp: string | null;
  observedAt: string;
  headerText: string;
  descriptionText: string | null;
  cause: string | null;
  effect: string | null;
  routeIds: string[];
  stopIds: string[];
};

export type FeedFetchResult = {
  body: Uint8Array;
  status: number;
  contentType: string | null;
  fetchedAt: string;
};

export class FeedFetchError extends Error {
  readonly stage = "fetch";

  constructor(message: string) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export class FeedDecodeError extends Error {
  readonly stage = "decode";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "FeedDecodeError";
  }
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value !== null && typeof value === "object" && "low" in value) {
    const low = Number((value as { low: number }).low);
    const high = Number((value as { high?: number }).high ?? 0);
    return Number.isFinite(low) && Number.isFinite(high)
      ? high * 2 ** 32 + (low >>> 0)
      : null;
  }
  return null;
}

function isoFromEpochSeconds(value: unknown): string | null {
  const seconds = numberValue(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstNonNull(...values: Array<string | null>): string | null {
  return values.find((value) => value !== null) ?? null;
}

function firstNumber(...values: Array<number | null>): number | null {
  return values.find((value) => value !== null) ?? null;
}

function translatedText(value: unknown): string | null {
  const translations = record(value).translation;
  if (!Array.isArray(translations)) return null;
  for (const translation of translations) {
    const value = text(record(translation).text);
    if (value) return value;
  }
  return null;
}

export async function fetchFeed(
  feedUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      accept: "application/x-protobuf, application/octet-stream",
    };
    if (apiKey) headers["x-api-key"] = apiKey;

    const response = await fetchImpl(feedUrl, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new FeedFetchError(
        `${feedUrl}: ${response.status} ${response.statusText}`,
      );
    }

    return {
      body: new Uint8Array(await response.arrayBuffer()),
      status: response.status,
      contentType: response.headers.get("content-type"),
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new FeedFetchError(`Unable to fetch ${feedUrl}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function decodeFeed(body: Uint8Array) {
  try {
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FeedDecodeError(`Unable to decode GTFS-Realtime protobuf: ${message}`, error);
  }
}

function feedTimestamp(feed: UnknownRecord): string | null {
  return isoFromEpochSeconds(record(feed.header).timestamp);
}

function stopTimeRecord(stopTimeUpdate: unknown): {
  stopId: string | null;
  stopSequence: number | null;
  scheduledArrival: string | null;
  predictedArrival: string | null;
  delaySeconds: number | null;
} {
  const update = record(stopTimeUpdate);
  const arrival = record(update.arrival);
  const departure = record(update.departure);

  return {
    stopId: text(update.stopId),
    stopSequence: numberValue(update.stopSequence),
    scheduledArrival: null,
    predictedArrival: firstNonNull(
      isoFromEpochSeconds(arrival.time),
      isoFromEpochSeconds(departure.time),
    ),
    delaySeconds: firstNumber(
      numberValue(arrival.delay),
      numberValue(departure.delay),
    ),
  };
}

export function normalizeTripUpdates(
  feed: unknown,
  feedName: string,
  observedAt: string,
): NormalizedTripRecord[] {
  const root = record(feed);
  const headerTimestamp = feedTimestamp(root);
  const entities = Array.isArray(root.entity) ? root.entity : [];
  const records: NormalizedTripRecord[] = [];

  for (const entity of entities) {
    const tripUpdate = record(record(entity).tripUpdate);
    const trip = record(tripUpdate.trip);
    const tripId = text(trip.tripId);
    if (!tripId) continue;

    const stopUpdates = Array.isArray(tripUpdate.stopTimeUpdate)
      ? tripUpdate.stopTimeUpdate
      : [];
    const firstStop = stopUpdates
      .map(stopTimeRecord)
      .find((candidate) => candidate.stopId !== null) ?? {
      stopId: null,
      scheduledArrival: null,
      predictedArrival: null,
      delaySeconds: null,
    };

    records.push({
      feedName,
      feedTimestamp: headerTimestamp,
      observedAt,
      routeId: text(trip.routeId),
      tripId,
      directionId: text(trip.directionId),
      startTime: text(trip.startTime),
      stopId: firstStop.stopId,
      scheduledArrival: firstStop.scheduledArrival,
      predictedArrival: firstStop.predictedArrival,
      delaySeconds: firstStop.delaySeconds,
    });
  }

  return records;
}

/**
 * Returns one normalized record for every stop-time update in the feed.
 * Phase 1 uses a representative trip row for its probe; Phase 3 persists
 * this complete stop-level history.
 */
export function normalizeStopTimeRecords(
  feed: unknown,
  feedName: string,
  observedAt: string,
): NormalizedStopTimeRecord[] {
  const root = record(feed);
  const headerTimestamp = feedTimestamp(root);
  const entities = Array.isArray(root.entity) ? root.entity : [];
  const records: NormalizedStopTimeRecord[] = [];

  for (const entity of entities) {
    const tripUpdate = record(record(entity).tripUpdate);
    const trip = record(tripUpdate.trip);
    const tripId = text(trip.tripId);
    if (!tripId) continue;

    const stopUpdates = Array.isArray(tripUpdate.stopTimeUpdate)
      ? tripUpdate.stopTimeUpdate
      : [];
    for (const stopUpdate of stopUpdates) {
      const stop = stopTimeRecord(stopUpdate);
      records.push({
        feedName,
        feedTimestamp: headerTimestamp,
        observedAt,
        routeId: text(trip.routeId),
        tripId,
        directionId: text(trip.directionId),
        startTime: text(trip.startTime),
        ...stop,
      });
    }
  }

  return records;
}

/**
 * Returns one normalized record for every service alert in the feed.
 * The current API uses route associations for live alert filtering; stop and
 * trip associations are retained as stop IDs where the feed supplies them.
 */
export function normalizeAlerts(
  feed: unknown,
  feedName: string,
  observedAt: string,
): NormalizedAlertRecord[] {
  const root = record(feed);
  const headerTimestamp = feedTimestamp(root);
  const entities = Array.isArray(root.entity) ? root.entity : [];
  const records: NormalizedAlertRecord[] = [];

  for (const entityValue of entities) {
    const entity = record(entityValue);
    const alert = record(entity.alert);
    const alertId = text(entity.id);
    const headerText = translatedText(alert.headerText);
    if (!alertId || !headerText) continue;

    const routeIds = new Set<string>();
    const stopIds = new Set<string>();
    const informedEntities = Array.isArray(alert.informedEntity)
      ? alert.informedEntity
      : [];
    for (const informedValue of informedEntities) {
      const informed = record(informedValue);
      const routeId = text(informed.routeId) ?? text(record(informed.trip).routeId);
      const stopId = text(informed.stopId) ?? text(record(informed.trip).stopId);
      if (routeId) routeIds.add(routeId);
      if (stopId) stopIds.add(stopId);
    }

    records.push({
      feedName,
      alertId,
      feedTimestamp: headerTimestamp,
      observedAt,
      headerText,
      descriptionText: translatedText(alert.descriptionText),
      cause: text(alert.cause),
      effect: text(alert.effect),
      routeIds: [...routeIds],
      stopIds: [...stopIds],
    });
  }

  return records;
}

export function distinctTripRecords(
  records: NormalizedTripRecord[],
): NormalizedTripRecord[] {
  const seen = new Set<string>();
  return records.filter((item) => {
    if (seen.has(item.tripId)) return false;
    seen.add(item.tripId);
    return true;
  });
}
