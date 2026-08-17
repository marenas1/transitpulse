# TransitPulse Phase 3 - Implementation Plan

## Objective

Run the first persistent collection loop:

```text
MTA GTFS-Realtime
        ↓
fetch → decode → normalize → resolve static references
        ↓
PostgreSQL transaction
  trip observations + stop-time observations
        ↓
ingestion run health record
```

The worker is independent of the browser. It can run once for a smoke test or continuously at the configured polling cadence.

## Scope

### Included

- PostgreSQL 15-compatible migration for static references, observations, and ingestion runs.
- Idempotent static reference import from the Phase 2 snapshot.
- A pooled `pg` repository using parameterized queries and transactions.
- Trip-level and stop-time-level realtime persistence.
- Static trip/route/stop association before persistence.
- Database-enforced duplicate protection with feed timestamp and source keys.
- Success, partial, and failed ingestion health records.
- Configurable live feed or captured protobuf input.
- One-cycle and continuous worker modes.
- Deterministic fake-store tests and a real PostgreSQL smoke path.

### Deferred

- API endpoints and frontend consumption.
- Hourly/daily aggregates.
- Actual arrival-event inference.
- Retention cleanup and partitioning.
- Service alerts and vehicle-position persistence.
- A distributed job scheduler or multiple worker replicas.

## Implementation Units

| Unit | Responsibility |
|---|---|
| `db/migrations/001_phase3.sql` | PostgreSQL tables, constraints, indexes, and migration marker. |
| `src/phase3/config.ts` | Database, feed, polling, static-import, and runtime settings. |
| `src/phase3/repository.ts` | Pooled PostgreSQL access, static import, transactional observation writes, and health writes. |
| `src/phase3/worker.ts` | Fetch/decode/normalize/resolve cycle and continuous polling loop. |
| `src/phase3/cli.ts` | Startup migration, static reference import, signal handling, and worker execution. |
| `test/phase3.test.ts` | Worker behavior and duplicate accounting using a deterministic fake store. |
| `docker-compose.yml` | Repeatable local PostgreSQL service for Phase 3 smoke testing. |

## Persistence Model

- `routes`, `stations`, `stops`, `trips`, and `scheduled_stop_times` hold the Phase 2 reference snapshot.
- `trip_observations` records one row per source trip update and preserves the realtime source trip ID.
- `stop_time_observations` records each stop-time update, including prediction and feed-provided delay.
- `ingestion_runs` records the health summary for every fetch/decode/persist cycle.
- `feed_timestamp` identifies the source snapshot; `observed_at` identifies the application observation time; `ingested_at` identifies persistence time.
- `source_entity_key` is stable within a feed snapshot, allowing retries of the same payload to become duplicates instead of new history.

## Duplicate Policy

The database treats a trip observation as duplicate when `(feed_name, feed_timestamp, source_entity_key)` already exists. A stop-time observation uses the same key shape, with the source key derived from source trip ID, stop ID, and stop sequence. PostgreSQL `UNIQUE` constraints and `ON CONFLICT DO NOTHING` make retries safe under the database's concurrency rules.

The worker counts rows returned by `INSERT ... RETURNING` as inserted and derives ignored duplicates from the candidate count. A failed transaction records a failed ingestion run rather than reporting a partial write as successful.

## Health Contract

Every cycle records:

```text
status
started_at / finished_at / duration_ms
feed_timestamp / fetched_at / HTTP status / bytes received
entities_seen / trip_updates_seen / stop_updates_seen
trip_observations_inserted / stop_observations_inserted
duplicates_ignored / unresolved_reference_records / rejected_records / error_count
error_message when failed
```

## Execution Sequence

1. Start PostgreSQL locally with `docker compose up -d postgres`, or provide `TRANSITPULSE_DATABASE_URL`.
2. Run migrations and import the Phase 2 static snapshot.
3. Run one controlled cycle against the captured Phase 1 protobuf.
4. Verify inserted rows and a second identical cycle's duplicate count.
5. Run the live one-cycle command.
6. Start continuous mode at the configured 30-second cadence.
7. For the production gate, observe 60 expected cycles over 30 minutes, at least 57 successful cycles, health rows for all cycles, and no duplicate rows beyond the expected ignored-retry count.

## Gate

Unresolved static associations are retained as source observations with a null `static_trip_id` when route and stop fields remain valid. They are counted separately from rejected rows so a changing static snapshot does not silently discard realtime history.

The implementation gate is split into two levels:

### Local implementation gate

- Schema migration succeeds.
- Phase 2 reference data imports.
- One captured feed cycle persists trip and stop-time observations.
- Replaying the same feed does not increase observation row counts.
- The second run reports ignored duplicates.
- Failed feed/decode paths produce a failed health record.

### Operational Phase 3 gate

- A 30-minute run completes 60 expected cycles at a 30-second cadence.
- At least 57 cycles succeed, which is 95%.
- Every cycle has an `ingestion_runs` record.
- The database contains no duplicate observation keys.
- Feed age, inserted rows, duplicates, duration, and errors can be queried without reading application logs.

## Exit Criteria

Phase 3 is complete when the local implementation gate passes and the worker is ready for the 30-minute operational run. The full operational gate is a runtime deployment check and should be recorded with its observed cycle counts rather than inferred from a short test.
