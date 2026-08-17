import {
  activeServiceIds,
  type StaticGtfsSnapshot,
  serviceDateForTimestamp,
  type StopReference,
  type TripReference,
} from "./gtfs.js";

export type RealtimeSampleRecord = {
  routeId: string | null;
  tripId: string;
  stopId: string | null;
  feedTimestamp: string | null;
};

export type ResolvedRealtimeRecord = {
  realtimeTripId: string;
  staticTripId: string;
  routeId: string;
  stopId: string;
  stationId: string | null;
  serviceDate: string;
  serviceId: string;
};

export type Mismatch = {
  kind: "route" | "trip" | "stop";
  realtimeId: string | null;
  tripId: string;
  reason: string;
};

export type ResolutionReport = {
  serviceDate: string;
  totalRecords: number;
  distinctRealtimeTrips: number;
  resolvedRecords: ResolvedRealtimeRecord[];
  mismatches: Mismatch[];
  summary: {
    resolved: number;
    unresolved: number;
    ambiguousTrips: number;
    routeMismatches: number;
    tripMismatches: number;
    stopMismatches: number;
  };
};

function candidatesForTrip(
  snapshot: StaticGtfsSnapshot,
  record: RealtimeSampleRecord,
  activeServices: Set<string>,
): TripReference[] {
  const candidates = snapshot.tripsByRealtimeId.get(record.tripId) ?? [];
  return candidates.filter(
    (candidate) =>
      (!record.routeId || candidate.routeId === record.routeId) &&
      activeServices.has(candidate.serviceId),
  );
}

function stopFor(
  snapshot: StaticGtfsSnapshot,
  stopId: string | null,
): StopReference | null {
  return stopId ? snapshot.stops.get(stopId) ?? null : null;
}

export function resolveRealtimeSample(
  snapshot: StaticGtfsSnapshot,
  records: RealtimeSampleRecord[],
  timeZone: string,
): ResolutionReport {
  const firstTimestamp = records.find((record) => record.feedTimestamp)?.feedTimestamp;
  if (!firstTimestamp) throw new Error("Realtime sample has no feed timestamp");
  const serviceDate = serviceDateForTimestamp(firstTimestamp, timeZone);
  const activeServices = activeServiceIds(snapshot, serviceDate);
  const resolvedRecords: ResolvedRealtimeRecord[] = [];
  const mismatches: Mismatch[] = [];
  const distinctRealtimeTrips = new Set(records.map((record) => record.tripId));

  for (const record of records) {
    if (record.routeId && !snapshot.routes.has(record.routeId)) {
      mismatches.push({
        kind: "route",
        realtimeId: record.routeId,
        tripId: record.tripId,
        reason: "Realtime route is absent from static routes",
      });
      continue;
    }

    const candidates = candidatesForTrip(snapshot, record, activeServices);
    if (candidates.length === 0) {
      mismatches.push({
        kind: "trip",
        realtimeId: record.tripId,
        tripId: record.tripId,
        reason: "No active static trip matched the realtime ID suffix and route",
      });
      continue;
    }
    if (candidates.length > 1) {
      mismatches.push({
        kind: "trip",
        realtimeId: record.tripId,
        tripId: record.tripId,
        reason: `Static trip match is ambiguous across ${candidates.length} active trips`,
      });
      continue;
    }

    const trip = candidates[0];
    const stop = stopFor(snapshot, record.stopId);
    if (!stop || !record.stopId) {
      mismatches.push({
        kind: "stop",
        realtimeId: record.stopId,
        tripId: record.tripId,
        reason: "Realtime stop is absent from static stops",
      });
      continue;
    }

    resolvedRecords.push({
      realtimeTripId: record.tripId,
      staticTripId: trip.staticTripId,
      routeId: trip.routeId,
      stopId: stop.stopId,
      stationId: stop.stationId,
      serviceDate,
      serviceId: trip.serviceId,
    });
  }

  const count = (kind: Mismatch["kind"]) =>
    mismatches.filter((mismatch) => mismatch.kind === kind).length;
  const ambiguousTrips = mismatches.filter((mismatch) =>
    mismatch.reason.startsWith("Static trip match is ambiguous"),
  ).length;

  return {
    serviceDate,
    totalRecords: records.length,
    distinctRealtimeTrips: distinctRealtimeTrips.size,
    resolvedRecords,
    mismatches,
    summary: {
      resolved: resolvedRecords.length,
      unresolved: mismatches.length,
      ambiguousTrips,
      routeMismatches: count("route"),
      tripMismatches: count("trip"),
      stopMismatches: count("stop"),
    },
  };
}
