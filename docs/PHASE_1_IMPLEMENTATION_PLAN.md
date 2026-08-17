# TransitPulse Phase 1 - Implementation Plan

## Objective

Prove the first vertical slice of the TransitPulse data path:

```text
MTA GTFS-Realtime feed
        ↓
fetch binary protobuf
        ↓
decode FeedMessage
        ↓
normalize Trip Updates
        ↓
capture repeatable sample
```

The phase gate is satisfied when one recorded MTA feed produces normalized data for at least 10 distinct trips.

## Scope

### Included

- A TypeScript/Node project with environment-based feed configuration.
- One MTA subway Trip Updates feed.
- Binary protobuf download and decode.
- Feed timestamp and local observation timestamp.
- Normalized route, trip, stop, prediction, and delay fields.
- A representative normalized record for each distinct trip.
- A captured binary feed fixture for repeatable tests.
- Explicit fetch and decode failure output.
- An executable gate that fails unless at least 10 distinct trips are present.

### Deferred

- PostgreSQL persistence.
- Static GTFS imports and schedule joins.
- Service-day resolution beyond preserving feed and observation timestamps.
- Deduplication across polling cycles.
- Actual arrival-event inference.
- Analytics, API routes, frontend, and map rendering.

## Implementation Units

| Unit | Responsibility |
|---|---|
| `src/phase1/config.ts` | Read safe defaults and environment overrides. |
| `src/phase1/feed.ts` | Fetch, decode, and normalize GTFS-Realtime data. |
| `src/phase1/cli.ts` | Run the live probe, print JSON, and enforce the gate. |
| `test/phase1.test.ts` | Verify normalization, decode failures, and the captured fixture. |
| `fixtures/mta-nyct-gtfs.bin` | Repeatable binary payload captured from the configured MTA endpoint. |
| `fixtures/mta-nyct-gtfs.sample.json` | Captured normalized output and gate summary for the binary fixture. |
| `.env.example` | Document endpoint, optional key, sample size, and timeout configuration. |

## Normalized Output Contract

Each representative trip record contains:

```json
{
  "feedName": "nyct-1-2-3-4-5-6-7",
  "feedTimestamp": "2026-08-17T15:20:00.000Z",
  "observedAt": "2026-08-17T15:20:04.000Z",
  "routeId": "2",
  "tripId": "...",
  "directionId": "0",
  "startTime": "17:32:00",
  "stopId": "127N",
  "scheduledArrival": null,
  "predictedArrival": "2026-08-17T15:38:00.000Z",
  "delaySeconds": 180
}
```

`scheduledArrival` is intentionally nullable in Phase 1 because the realtime feed does not by itself provide the static schedule context. Schedule joins belong to Phase 2. `delaySeconds` is preserved when the realtime feed provides it; Phase 1 does not calculate schedule delay.

## Execution Sequence

1. Install dependencies.
2. Copy `.env.example` to `.env` only when local overrides are needed.
3. Run the unit and fixture tests.
4. Run the live probe against the configured endpoint.
5. Save the binary response as the fixture.
6. Run `npm run phase1:fixture` and save its JSON output as the normalized sample.
7. Run the fixture gate and confirm at least 10 distinct trips.
8. Record the feed timestamp, observation timestamp, trip count, and any decode failures in the implementation handoff.

## Gate

The gate passes when:

- The captured protobuf decodes successfully.
- The decoded feed contains at least 10 distinct `tripId` values.
- Every sampled trip record includes `feedTimestamp`, `observedAt`, and `tripId`.
- Each sampled record includes a route or an explicit `null`, a stop or an explicit `null`, and prediction/delay values when supplied by the feed.
- The command reports `PASS` and exits with code 0.
- Malformed protobuf input produces a visible `stage: "decode"` failure and a non-zero exit code.

## Exit Criteria

Phase 1 is complete when the gate passes from the recorded fixture and the live command can be rerun without changing source code. Phase 2 can then use the normalized `routeId`, `tripId`, and `stopId` fields to begin static GTFS resolution.
