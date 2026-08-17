# TransitPulse Phase 2 - Implementation Plan

## Objective

Establish a normalized static GTFS reference snapshot that can interpret the Phase 1 realtime sample:

```text
MTA static GTFS ZIP
        ↓
unzip + parse CSV
        ↓
routes · stations · stops · trips · scheduled stop times
        ↓
service calendar + after-midnight normalization
        ↓
realtime trip/stop resolution report
```

The phase gate is satisfied when at least 10 distinct Phase 1 realtime trips resolve to static trips and their stop IDs resolve to static stops, with no ambiguous service-day assignment in the gate sample.

## Scope

### Included

- Current MTA subway static GTFS ZIP as a repeatable local fixture.
- CSV parsing for `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`, `calendar_dates.txt`, and `feed_info.txt`.
- Separate station and platform/directional stop references.
- Static trip identity, route identity, service ID, direction, and headsign.
- Scheduled stop-time import with ordered stop sequences.
- GTFS clock values such as `24:08:00` normalized to the next calendar date while preserving the original service date and offset.
- Matching of Phase 1 realtime trip IDs to static IDs, including the MTA's static-trip prefix convention.
- Route, trip, and stop mismatch reporting.
- A Phase 2 CLI and repeatable tests.

### Deferred

- PostgreSQL persistence and migrations; that is Phase 3.
- Realtime observation deduplication.
- Actual arrival inference and delay metrics.
- Full service-day assignment for every historical observation.
- Download scheduling, retention, and worker health.

## Implementation Units

| Unit | Responsibility |
|---|---|
| `src/phase2/config.ts` | Static feed source, Phase 1 sample path, timezone, and gate configuration. |
| `src/phase2/gtfs.ts` | ZIP extraction, CSV parsing, reference snapshot creation, service calendars, and time normalization. |
| `src/phase2/resolve.ts` | Realtime route/trip/stop matching and mismatch reporting. |
| `src/phase2/cli.ts` | Import the fixture, print counts and mismatches, and enforce the Phase 2 gate. |
| `test/phase2.test.ts` | Validate static parsing, after-midnight behavior, and realtime resolution. |
| `fixtures/mta-gtfs-subway.zip` | Current static GTFS source used for repeatable local validation. |
| `fixtures/phase2-reference-report.json` | Captured counts, resolution summary, mismatch report, and gate result. |

## Operational Data Contract

The importer produces these logical reference records before Phase 3 chooses database tables:

```text
Route
  routeId, shortName, longName, routeType, color

Station
  stationId, name, latitude, longitude

Stop
  stopId, stationId, name, latitude, longitude, locationType

Trip
  staticTripId, realtimeTripIdSuffix, routeId, serviceId,
  directionId, headsign

ScheduledStopTime
  staticTripId, stopId, stopSequence,
  arrivalTime, departureTime,
  serviceDate, normalizedLocalDateTime, dayOffset
```

The `staticTripId` is preserved exactly as supplied by GTFS. Realtime trip IDs are matched first by exact equality, then by the MTA-compatible suffix rule: a static ID may end with `_${realtimeTripId}`. The suffix rule is a reference-resolution aid, not a replacement for preserving the source IDs.

## Execution Sequence

1. Install the CSV and ZIP parsing dependencies.
2. Download or provide the static subway GTFS ZIP.
3. Parse reference files and report row counts.
4. Parse all scheduled stop times and count after-midnight times.
5. Load the Phase 1 normalized sample.
6. Resolve its route, trip, and stop identities against the snapshot.
7. Exercise a synthetic midnight service-day case.
8. Save the compact reference report and run the Phase 2 tests.

## Gate

The gate passes when:

- The static ZIP parses successfully.
- Routes, stations, stops, trips, and scheduled stop times each contain records.
- At least 10 distinct Phase 1 realtime trips resolve to static trips.
- The same gate records resolve their representative stop IDs to static stops.
- Any unresolved route, trip, or stop is listed with an explicit reason rather than silently dropped.
- `24:08:00` on service date `2026-08-17` normalizes to local wall time `2026-08-18T00:08:00` with `dayOffset: 1` while retaining service date `2026-08-17`.
- The command reports `PASS` and exits with code 0.

## Exit Criteria

Phase 2 is complete when the report and tests prove that the Phase 1 identifiers can be interpreted against the static feed and after-midnight schedule values remain tied to one service date. Phase 3 can then persist these reference records and associate them with realtime observations.
