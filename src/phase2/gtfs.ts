import { readFile } from "node:fs/promises";

import { parse } from "csv-parse";
import { strFromU8, unzipSync } from "fflate";

type CsvRow = Record<string, string>;

export type RouteReference = {
  routeId: string;
  shortName: string;
  longName: string;
  routeType: number | null;
  color: string | null;
};

export type StationReference = {
  stationId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
};

export type StopReference = {
  stopId: string;
  stationId: string | null;
  name: string;
  latitude: number | null;
  longitude: number | null;
  locationType: number | null;
};

export type TripReference = {
  staticTripId: string;
  realtimeTripIdSuffix: string;
  routeId: string;
  serviceId: string;
  directionId: string | null;
  headsign: string | null;
};

export type NormalizedGtfsTime = {
  original: string;
  serviceDate: string;
  normalizedLocalDateTime: string;
  secondsSinceServiceMidnight: number;
  dayOffset: number;
};

export type ScheduledStopTimeReference = {
  staticTripId: string;
  stopId: string;
  stopSequence: number;
  arrivalTime: NormalizedGtfsTime;
  departureTime: NormalizedGtfsTime;
};

export type ServiceCalendar = {
  serviceId: string;
  startDate: string;
  endDate: string;
  weekdays: Set<number>;
};

export type StaticGtfsSnapshot = {
  feedVersion: string | null;
  routes: Map<string, RouteReference>;
  stations: Map<string, StationReference>;
  stops: Map<string, StopReference>;
  trips: Map<string, TripReference>;
  tripsByRealtimeId: Map<string, TripReference[]>;
  scheduledStopTimesByTrip: Map<string, ScheduledStopTimeReference[]>;
  calendars: Map<string, ServiceCalendar>;
  calendarExceptions: Map<string, Map<string, "added" | "removed">>;
  counts: {
    routes: number;
    stations: number;
    stops: number;
    trips: number;
    scheduledStopTimes: number;
    afterMidnightStopTimes: number;
    calendars: number;
    calendarExceptions: number;
  };
};

function required(row: CsvRow, field: string): string {
  return row[field]?.trim() ?? "";
}

function optional(row: CsvRow, field: string): string | null {
  const value = row[field]?.trim();
  return value ? value : null;
}

function integer(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function decimal(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromGtfs(value: string): string {
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`Invalid GTFS date: ${value}`);
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function dateToGtfs(value: string): string {
  return value.replaceAll("-", "");
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function normalizeGtfsTime(
  serviceDate: string,
  value: string,
): NormalizedGtfsTime {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid GTFS time: ${value}`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) {
    throw new Error(`Invalid GTFS time: ${value}`);
  }

  const secondsSinceServiceMidnight = hours * 3600 + minutes * 60 + seconds;
  const dayOffset = Math.floor(hours / 24);
  const normalizedHours = String(hours % 24).padStart(2, "0");
  const normalizedDate = addDays(serviceDate, dayOffset);

  return {
    original: value,
    serviceDate,
    normalizedLocalDateTime: `${normalizedDate}T${normalizedHours}:${match[2]}:${match[3]}`,
    secondsSinceServiceMidnight,
    dayOffset,
  };
}

export function serviceDateForTimestamp(
  timestamp: string,
  timeZone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

async function parseRows(data: Uint8Array): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const parser = parse(strFromU8(data), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  for await (const row of parser) rows.push(row as CsvRow);
  return rows;
}

function bytesFor(files: Record<string, Uint8Array>, name: string): Uint8Array {
  const data = files[name];
  if (!data) throw new Error(`Static GTFS ZIP is missing ${name}`);
  return data;
}

function realtimeSuffix(staticTripId: string): string {
  const generatedPrefix = /_(\d{6}_.+)$/.exec(staticTripId);
  if (generatedPrefix) return generatedPrefix[1];
  const separator = staticTripId.lastIndexOf("_");
  return separator >= 0 ? staticTripId.slice(separator + 1) : staticTripId;
}

function activeWeekdays(row: CsvRow): Set<number> {
  const weekdays = new Set<number>();
  for (const [field, day] of [
    ["sunday", 0],
    ["monday", 1],
    ["tuesday", 2],
    ["wednesday", 3],
    ["thursday", 4],
    ["friday", 5],
    ["saturday", 6],
  ] as const) {
    if (row[field] === "1") weekdays.add(day);
  }
  return weekdays;
}

function feedVersionFrom(rows: CsvRow[]): string | null {
  return rows.length > 0 ? optional(rows[0], "feed_version") : null;
}

export async function loadStaticGtfs(
  zipPath: string,
): Promise<StaticGtfsSnapshot> {
  const files = unzipSync(await readFile(zipPath));
  const [routeRows, stopRows, tripRows, stopTimeRows, calendarRows, exceptionRows, feedInfoRows] =
    await Promise.all([
      parseRows(bytesFor(files, "routes.txt")),
      parseRows(bytesFor(files, "stops.txt")),
      parseRows(bytesFor(files, "trips.txt")),
      parseRows(bytesFor(files, "stop_times.txt")),
      parseRows(bytesFor(files, "calendar.txt")),
      parseRows(bytesFor(files, "calendar_dates.txt")),
      parseRows(bytesFor(files, "feed_info.txt")),
    ]);

  const routes = new Map<string, RouteReference>();
  for (const row of routeRows) {
    const routeId = required(row, "route_id");
    if (!routeId) continue;
    routes.set(routeId, {
      routeId,
      shortName: required(row, "route_short_name"),
      longName: required(row, "route_long_name"),
      routeType: integer(optional(row, "route_type")),
      color: optional(row, "route_color"),
    });
  }

  const stations = new Map<string, StationReference>();
  const stops = new Map<string, StopReference>();
  for (const row of stopRows) {
    const stopId = required(row, "stop_id");
    if (!stopId) continue;
    const locationType = integer(optional(row, "location_type"));
    const parentStation = optional(row, "parent_station");
    const stop: StopReference = {
      stopId,
      stationId: parentStation ?? (locationType === 1 ? stopId : null),
      name: required(row, "stop_name"),
      latitude: decimal(optional(row, "stop_lat")),
      longitude: decimal(optional(row, "stop_lon")),
      locationType,
    };
    stops.set(stopId, stop);
    if (locationType === 1) {
      stations.set(stopId, {
        stationId: stopId,
        name: stop.name,
        latitude: stop.latitude,
        longitude: stop.longitude,
      });
    }
  }

  const trips = new Map<string, TripReference>();
  const tripsByRealtimeId = new Map<string, TripReference[]>();
  for (const row of tripRows) {
    const staticTripId = required(row, "trip_id");
    if (!staticTripId) continue;
    const trip: TripReference = {
      staticTripId,
      realtimeTripIdSuffix: realtimeSuffix(staticTripId),
      routeId: required(row, "route_id"),
      serviceId: required(row, "service_id"),
      directionId: optional(row, "direction_id"),
      headsign: optional(row, "trip_headsign"),
    };
    trips.set(staticTripId, trip);
    const candidates = tripsByRealtimeId.get(trip.realtimeTripIdSuffix) ?? [];
    candidates.push(trip);
    tripsByRealtimeId.set(trip.realtimeTripIdSuffix, candidates);
  }

  const calendars = new Map<string, ServiceCalendar>();
  for (const row of calendarRows) {
    const serviceId = required(row, "service_id");
    if (!serviceId) continue;
    calendars.set(serviceId, {
      serviceId,
      startDate: dateFromGtfs(required(row, "start_date")),
      endDate: dateFromGtfs(required(row, "end_date")),
      weekdays: activeWeekdays(row),
    });
  }

  const calendarExceptions = new Map<
    string,
    Map<string, "added" | "removed">
  >();
  for (const row of exceptionRows) {
    const serviceId = required(row, "service_id");
    const date = dateFromGtfs(required(row, "date"));
    const type = required(row, "exception_type");
    if (!serviceId || !date || (type !== "1" && type !== "2")) continue;
    const exceptions = calendarExceptions.get(serviceId) ?? new Map();
    exceptions.set(date, type === "1" ? "added" : "removed");
    calendarExceptions.set(serviceId, exceptions);
  }

  const scheduledStopTimesByTrip = new Map<
    string,
    ScheduledStopTimeReference[]
  >();
  let scheduledStopTimes = 0;
  let afterMidnightStopTimes = 0;
  for (const row of stopTimeRows) {
    const staticTripId = required(row, "trip_id");
    const stopId = required(row, "stop_id");
    const arrival = required(row, "arrival_time");
    const departure = required(row, "departure_time");
    if (!staticTripId || !stopId || !arrival || !departure) continue;

    // GTFS times are relative to a service date. The concrete date is applied
    // when a service calendar is selected for a realtime observation.
    const serviceDate = "1970-01-01";
    const arrivalTime = normalizeGtfsTime(serviceDate, arrival);
    const departureTime = normalizeGtfsTime(serviceDate, departure);
    const item: ScheduledStopTimeReference = {
      staticTripId,
      stopId,
      stopSequence: integer(required(row, "stop_sequence")) ?? 0,
      arrivalTime,
      departureTime,
    };
    const items = scheduledStopTimesByTrip.get(staticTripId) ?? [];
    items.push(item);
    scheduledStopTimesByTrip.set(staticTripId, items);
    scheduledStopTimes += 1;
    if (arrivalTime.dayOffset > 0 || departureTime.dayOffset > 0) {
      afterMidnightStopTimes += 1;
    }
  }

  for (const items of scheduledStopTimesByTrip.values()) {
    items.sort((left, right) => left.stopSequence - right.stopSequence);
  }

  return {
    feedVersion: feedVersionFrom(feedInfoRows),
    routes,
    stations,
    stops,
    trips,
    tripsByRealtimeId,
    scheduledStopTimesByTrip,
    calendars,
    calendarExceptions,
    counts: {
      routes: routes.size,
      stations: stations.size,
      stops: stops.size,
      trips: trips.size,
      scheduledStopTimes,
      afterMidnightStopTimes,
      calendars: calendars.size,
      calendarExceptions: [...calendarExceptions.values()].reduce(
        (total, exceptions) => total + exceptions.size,
        0,
      ),
    },
  };
}

export function applyServiceDate(
  value: NormalizedGtfsTime,
  serviceDate: string,
): NormalizedGtfsTime {
  return normalizeGtfsTime(serviceDate, value.original);
}

export function activeServiceIds(
  snapshot: StaticGtfsSnapshot,
  serviceDate: string,
): Set<string> {
  const date = new Date(`${serviceDate}T00:00:00Z`);
  const day = date.getUTCDay();
  const active = new Set<string>();

  for (const [serviceId, calendar] of snapshot.calendars) {
    if (serviceDate < calendar.startDate || serviceDate > calendar.endDate) {
      continue;
    }
    const exception = snapshot.calendarExceptions.get(serviceId)?.get(serviceDate);
    if (exception === "removed") continue;
    if (exception === "added" || calendar.weekdays.has(day)) active.add(serviceId);
  }

  for (const [serviceId, exceptions] of snapshot.calendarExceptions) {
    if (exceptions.get(serviceDate) === "added") active.add(serviceId);
  }
  return active;
}

export function materializeTripStopTimes(
  snapshot: StaticGtfsSnapshot,
  staticTripId: string,
  serviceDate: string,
): ScheduledStopTimeReference[] {
  return (snapshot.scheduledStopTimesByTrip.get(staticTripId) ?? []).map(
    (item) => ({
      ...item,
      arrivalTime: applyServiceDate(item.arrivalTime, serviceDate),
      departureTime: applyServiceDate(item.departureTime, serviceDate),
    }),
  );
}

export function gtfsDateToIso(value: string): string {
  return dateFromGtfs(value);
}

export function isoDateToGtfs(value: string): string {
  return dateToGtfs(value);
}
