# TransitPulse Phase 4 - Implementation Plan

## Objective

Expose trustworthy live state and historical delay metrics through a small, independently runnable HTTP API. Phase 4 is the backend analytics boundary; the browser application remains Phase 5.

## Scope

### 1. Metric definitions

- Resolve scheduled arrival from the Phase 2 static schedule and the observed service date.
- Preserve the source prediction and source-provided delay separately.
- Calculate `predicted_delay_seconds` from the source delay when present, otherwise from predicted arrival minus scheduled arrival.
- Define a late observation as a prediction at least five minutes late (`300` seconds).
- Ignore rows without a usable delay value in averages and late-rate denominators; never convert missing values to zero.
- Label these Phase 4 metrics as prediction-observation metrics. Actual arrival event inference and prediction scoring remain a later capability because Phase 3 does not yet establish an actual stop event.

### 2. Analytics persistence

- Add Phase 4 migrations for service alerts and route/station daily metric tables.
- Keep raw observations as the audit source.
- Add a refreshable daily aggregate operation for common historical queries.

### 3. HTTP API

Implement a Node HTTP API with JSON responses and a consistent metadata envelope:

- `GET /health`
- `GET /api/live/routes`
- `GET /api/live/routes/:routeId`
- `GET /api/live/stations`
- `GET /api/live/stations/:stationId`
- `GET /api/live/trips/:tripId`
- `GET /api/live/alerts`
- `GET /api/analytics/network?range=24h|7d`
- `GET /api/analytics/routes/:routeId?range=24h|7d`
- `GET /api/analytics/stations/:stationId?range=24h|7d`
- `GET /api/rankings/routes?metric=avg_delay&range=24h|7d`
- `GET /api/rankings/stations?metric=avg_delay&range=24h|7d`

Every response identifies its range, sample count, collection start, latest observation, freshness, source-vs-derived value type, and metric basis. Ranking responses enforce a 100-sample evidence threshold and return an explicit insufficient-history result when it is not met.

### 4. Alert ingestion

Extend the normalized feed contract and Phase 3 persistence batch to retain current service alerts and their route associations. Alerts are upserted by feed and source alert ID, and become stale when they have not appeared within two polling intervals.

### 5. Verification

- Unit-test delay, median, percentile, late-rate, ranking, missing-value, and insufficient-sample behavior with hand-calculated fixtures.
- Test API routing, metadata, 404s, and the live/analytics response distinction with an in-memory repository.
- Keep the existing Phase 1-3 tests green.
- Run a PostgreSQL smoke test against the Phase 3 fixture to verify migration, alert persistence, live queries, and analytics queries.

## Gate for Phase 5

The Phase 4 gate passes when hand-calculated fixtures match API values for average delay, late-observation rate, and at least one ranking; missing values are excluded rather than treated as zero; rankings with fewer than 100 usable samples are explicitly marked insufficient; and the API distinguishes source live state from derived historical metrics.

## Non-goals

- React or Next.js UI work; that is Phase 5.
- WebSockets or browser push; the first API is pollable.
- Machine-learning predictions.
- Claiming a predicted stop update is an actual arrival. Actual-event inference and prediction accuracy are deferred until the dataset supports them.
