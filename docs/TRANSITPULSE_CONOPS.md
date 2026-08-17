# TransitPulse - Concept of Operations

> Sequencing note: This CONOPS turns the project specification into an operational baseline. It is intended to precede detailed requirements, architecture, and implementation planning.

## Table of Contents

- [Purpose](#purpose)
- [Problem Statement](#problem-statement)
- [Stakeholders & Roles](#stakeholders--roles)
- [System Overview](#system-overview)
- [Part 1: Continuous Data Collection and Feed Health](#part-1-continuous-data-collection-and-feed-health)
- [Part 2: Historical Transit Dataset](#part-2-historical-transit-dataset)
- [Part 3: Live Network Awareness](#part-3-live-network-awareness)
- [Part 4: Reliability Analytics and Rankings](#part-4-reliability-analytics-and-rankings)
- [Part 5: Prediction Accuracy and Delay Propagation](#part-5-prediction-accuracy-and-delay-propagation)
- [Part 6: Public Analytical Experience and Frontend Framework](#part-6-public-analytical-experience-and-frontend-framework)
- [Schema and Data Model Additions](#schema-and-data-model-additions)
- [Implementation Phases](#implementation-phases)
  - [Phase 1: Understand One Realtime Feed](#phase-1-understand-one-realtime-feed)
  - [Phase 2: Establish Static Transit Reference Data](#phase-2-establish-static-transit-reference-data)
  - [Phase 3: Persist Observations with an Independent Worker](#phase-3-persist-observations-with-an-independent-worker)
  - [Phase 4: Produce Trustworthy Metrics and APIs](#phase-4-produce-trustworthy-metrics-and-apis)
  - [Phase 5: Deliver the Browser-First Product Surface](#phase-5-deliver-the-browser-first-product-surface)
  - [Phase 6: Add the Live Map and Operational Hardening](#phase-6-add-the-live-map-and-operational-hardening)
  - [Phase 7: Expand Historical Insight](#phase-7-expand-historical-insight)
- [Design Decisions](#design-decisions)
- [Test Strategy](#test-strategy)
- [Open Questions](#open-questions)

## Purpose

- Give users a current, clearly dated view of NYC subway activity.
- Convert recurring MTA feed state into a queryable historical dataset.
- Explain route and station reliability over 24-hour, 7-day, 30-day, and longer ranges.
- Separate MTA source values from metrics calculated by TransitPulse.
- Keep collection and analytics available even when no one has the website open.

## Problem Statement

| Problem | Observed Impact |
|---|---|
| **Confirmed product constraint:** MTA realtime feeds describe current state, not historical performance. | A live feed alone cannot answer questions over 24 hours, 7 days, or 30 days, such as which route is least reliable or whether a station is improving week over week. |
| **Confirmed data-semantic problem:** a 30-second polling cycle can produce repeated observations of one prediction rather than distinct transit events. The specification illustrates 4 records across 90 seconds for the same evolving prediction. | Treating observations as arrivals would inflate event counts, distort delay rates, and make historical rankings unreliable. |
| **Projected data-volume concern:** at a 30-second polling cadence, each tracked trip-stop pair can generate approximately 2 observations per minute before deduplication. | Storage, indexes, and raw-table scans can grow as `2 × active trip-stop pairs × minutes`; the actual daily row count must be measured before retention is finalized. |
| **Confirmed identity problem:** a `trip_id` can be reused across service dates, and subway service crosses midnight. | A `trip_id`-only key can combine separate runs and assign observations to the wrong service day. The logical identity needs at least `trip_id + service_date`. |
| **Projected trust problem:** users can mistake a calculated reliability score or ranking for an official MTA measure. | Every analytical view needs its range, sample size, collection start, freshness, and calculation context so a 30-day result is not presented as an official real-time fact. |
| **Projected product-operations problem:** a live map, historical charts, and frequent refreshes create at least 3 different freshness and failure behaviors. | A browser request cannot be responsible for continuous collection. The product needs an independent worker, explicit stale states, and separate handling for live data versus historical data. |

## Stakeholders & Roles

| Stakeholder | Role | What They Need From This System |
|---|---|---|
| Public transit users and curious visitors | Browse live network state and historical performance | A quick current view, readable delay context, and honest freshness when data is unavailable or stale. |
| Data-oriented users | Compare routes, stations, time periods, and prediction quality | Reproducible metrics, visible sample sizes, selectable ranges, and a clear distinction between source values and derived measures. |
| Portfolio reviewers and hiring teams | Evaluate the engineering and analytical story | Evidence of continuous ingestion, normalized public data, historical storage, aggregation, observability, and measured outcomes. |
| TransitPulse operator/developer | Keep the collection pipeline running | Last successful fetch, feed age, records processed, duplicates, duration, errors, and a way to tell source delay from application delay. |
| Product owner | Control scope and decide when the dataset is mature enough for new features | An end-to-end MVP before simulations, machine learning, crowding estimates, or a complex service decomposition. |

## System Overview

```text
 MTA Static GTFS          MTA GTFS-Realtime
 routes/stops/schedules   trips/updates/alerts
          │                       │
          └──────────┬────────────┘
                     ▼
          Independent ingestion worker
        fetch → decode → normalize → validate
                     │
                     ▼
              PostgreSQL history
       reference data · observations · events
              alerts · aggregate metrics
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   Live / analytics API   Aggregation and
   with freshness context  health jobs
          │                     │
          ▼                     ▼
   Browser product surface   Operator health view
 live network · routes ·    feed age · errors ·
 stations · rankings        throughput · lag
```

TransitPulse continuously records MTA state, keeps the changing prediction history, infers actual stop events only when the evidence supports doing so, and publishes both live views and historical metrics. The website consumes an API; it does not determine whether collection occurs. The ingestion worker and aggregation jobs continue on their own schedule, while the frontend presents the latest available data with its age and provenance.

## Part 1: Continuous Data Collection and Feed Health

### Concept

The collection operation gives TransitPulse a durable memory of the subway network. It retrieves the selected MTA feeds on a regular cadence, translates feed entities into understandable trip and stop observations, and records enough timing information to distinguish source latency from TransitPulse processing time.

The operator can see whether collection is healthy without opening the public dashboard. A healthy state includes a recent successful fetch, a feed that is not stale, a known number of parsed entities, and a bounded error rate. A failed fetch is visible as a data-freshness problem rather than silently becoming an empty subway network.

### Why This Approach

An independent worker is chosen over ingestion during web requests because the historical dataset must continue growing when there are zero website visitors. It also gives feed polling, retry behavior, and database writes a lifecycle separate from browser traffic. The accepted trade-off is one additional deployable process; that process is small and directly reflects the product's central data-platform purpose.

Polling is chosen over waiting for push delivery because the MTA source is consumed as a periodically fetched GTFS-Realtime feed in the project scope. The cadence can be adjusted after measuring source freshness and rate limits. The accepted trade-off is that the dataset is a sampled record of feed state, not a perfect stream of every underlying train movement.

A normalized ingestion path is chosen over storing only protobuf payloads or writing feed entities directly into analytical tables. Raw feed captures can help diagnose parser changes, while normalized observations make the API and database useful to the rest of the product. The initial scope remains one subway realtime feed and the static reference data needed to interpret it; adding every possible MTA feed is deferred.

### Operational Scenarios

**Sunny Day**

1. The worker fetches a GTFS-Realtime response and records the source feed timestamp and ingestion timestamp when available.
2. It decodes Trip Updates, Stop Time Updates, alerts, and available vehicle or trip state.
3. It normalizes route, trip, stop, schedule, prediction, and delay fields into shared records.
4. It validates required identity and time fields, deduplicates records according to the chosen observation key, and persists accepted rows.
5. It publishes counts for parsed, inserted, duplicate, rejected, and failed records.
6. The health surface marks the feed healthy only when recent successful cycles meet the freshness policy.

**Failure Modes**

| Failure | Behavior |
|---|---|
| MTA endpoint is unavailable for one or more 30-second cycles | Retain the last known dataset, record the failure and last success, retry with bounded backoff, and expose the live view as stale rather than empty. |
| Protobuf response cannot be decoded | Preserve the failure context, do not write partial unvalidated data as current state, and keep the previous valid state available. |
| A trip update lacks a stop, route, or usable timestamp | Keep the record as rejected or incomplete with a reason; do not invent a station or assign it to an arbitrary service day. |
| The same observation is received repeatedly | Count it as a duplicate according to the logical key and avoid inflating historical volume or event counts. |
| A trip disappears from the feed | Mark the trip as no longer observed for the current collection window; do not infer cancellation or arrival from disappearance alone. |
| The worker restarts during a write | Resume from the next poll without producing duplicate logical observations; the health view shows the restart and recovery interval. |

### Implementation Touch Points

- `apps/worker/src/feeds/` - feed retrieval, response timing, and source metadata.
- `apps/worker/src/gtfs/` and `apps/worker/src/realtime/` - static and realtime decoding.
- `apps/worker/src/normalization/` - shared trip, stop, alert, and timestamp records.
- `apps/worker/src/jobs/` - recurring polling and health publication.
- `packages/db/` - migrations, persistence boundaries, indexes, and transaction policy.
- `packages/shared/` - types shared by the worker, API, and frontend.

### Expected Impact

The first operational proof is one understandable normalized Trip Update containing route, trip, stop, observed time, predicted time when present, and delay. Before the public live view is treated as trustworthy, a 30-minute run should show at least 95% successful poll cycles, bounded retries, and a complete health record for every cycle. The long-term collection baseline is measured as rows per poll, rows per day, duplicate rate, rejection rate, median ingestion duration, and feed-to-database lag.

## Part 2: Historical Transit Dataset

### Concept

The historical dataset lets users ask how the network behaved after the live moment has passed. It stores the schedule that the system was comparing against, each observed prediction over time, inferred actual stop events, and the service alerts that provide context for unusual performance.

TransitPulse keeps the difference between an observation and an event visible. A prediction observed at 10:00, 10:00:30, and 10:01 is a sequence of statements about the same possible arrival. An actual arrival is a separate event that can later be compared with both the schedule and the last available prediction.

### Why This Approach

PostgreSQL is chosen over Neo4j because the dominant questions join time, trip, route, stop, schedule, and aggregate values. Relational keys, date filtering, and aggregate queries match the initial workload. The accepted trade-off is that route topology and propagation relationships are expressed through relational fields and queries instead of graph traversal; a graph database can be reconsidered if future questions require graph-native analysis rather than descriptive stop sequences.

Raw observations and derived aggregates are kept as separate data products. Raw history preserves the evidence needed to recompute a metric, while hourly and daily tables keep common route and station queries from scanning every telemetry row. The accepted trade-off is more storage and more job coordination in exchange for predictable analytical response times and the ability to audit a result.

Composite trip identity uses service date alongside the feed trip identifier. This handles reuse across service days and subway operation across midnight. The accepted trade-off is more careful date normalization at ingestion and query time; that complexity is safer than silently joining separate service runs.

### Operational Scenarios

**Sunny Day**

1. Static GTFS establishes route, station, stop, trip, and scheduled stop-time context.
2. Each accepted realtime observation links to that context using trip, service date, route, and stop identities.
3. Prediction changes remain as historical observations instead of overwriting the previous value.
4. When an arrival or departure can be inferred from evidence, TransitPulse records an actual stop event separately.
5. Users can inspect the source values behind a delay or reliability metric.

**Failure Modes**

| Failure | Behavior |
|---|---|
| A prediction is missing but a trip update remains valid | Preserve the trip observation and mark prediction-derived metrics unavailable for that row. |
| A feed timestamp and ingestion timestamp differ | Store both when available so source latency and application latency remain distinguishable. |
| An observation arrives around midnight | Resolve it against the normalized service day and retain the calendar timestamp; do not rely on calendar date alone. |
| Static GTFS does not contain the referenced trip or stop | Preserve the source identity with an unresolved-reference status and report the mismatch for investigation. |
| An inferred event later conflicts with new evidence | Keep the observation history and mark the event as revised or uncertain; do not erase the evidence that led to the original inference. |
| Raw volume exceeds the expected daily rate | Alert the operator, measure the cause, and use aggregation or retention controls before adding a more complex database technology. |

### Implementation Touch Points

- `packages/db/schema/` - reference, observation, event, alert, and aggregate tables.
- `packages/db/migrations/` - versioned schema changes and indexes.
- `apps/worker/src/normalization/` - service-day and composite-identity resolution.
- `packages/analytics/` - delay formulas, event pairing, and metric definitions.
- `docs/data-model.md` - later detailed data-model documentation derived from this operational baseline.

### Expected Impact

At least 99% of accepted observation rows should carry an observed timestamp and a composite trip identity; rows that cannot meet that bar remain explicitly incomplete rather than being silently repaired. A representative 24-hour route or station query should be measured against a provisional P95 target of 2 seconds after daily aggregates exist. The actual retention period, row budget, and whether TimescaleDB is needed remain measurement-driven decisions.

## Part 3: Live Network Awareness

### Concept

The live experience is the immediate entry point. It shows the latest known routes, stations, active trips where the feed supports them, current delays, and active service alerts. Users can select a train to see its previous and next stop context, or select a station to see serving routes, incoming trains, and current disruptions.

The live view communicates its age. “No current trips,” “feed unavailable,” and “last update 4 minutes ago” are different operational states. The interface does not turn an ingestion outage into an apparently empty network.

### Why This Approach

The live browser view uses API polling rather than a first-version WebSocket stream. The source is already sampled on a polling cadence, and the MVP needs to prove collection, persistence, analytics, and user value before adding connection management and fan-out infrastructure. The trade-off is that a user may see updates at the next refresh rather than instantly; this is acceptable while the source-to-database lag is being measured.

The API remains between the database and the browser instead of exposing database queries directly to the frontend. This gives live and historical consumers one place to receive freshness, sample, provenance, and error context. The trade-off is an extra request boundary, balanced by a stable public contract and safer control of query cost.

The map is added after the API and basic pages prove the data path. A perfect geographic overlay is not allowed to delay a working live route and station experience. The trade-off is a staged visual experience; the data platform still demonstrates value before map rendering is complete.

### Operational Scenarios

**Sunny Day**

1. A user opens the Live view and sees the collection timestamp and current feed age.
2. The page loads current routes, stations, alerts, and active trip state from the live API.
3. The browser refreshes the live data on the agreed cadence and updates only the affected view state.
4. Selecting a trip shows route, direction, previous stop, next stop, scheduled time, predicted time, and current delay when those fields exist.
5. Selecting a station shows serving routes, incoming trains, current delays, and active alerts.

**Failure Modes**

| Failure | Behavior |
|---|---|
| The API is reachable but the latest successful ingestion is older than 2 polling intervals | Show stale status and the last update time; keep historical pages available if their data is healthy. |
| The live API returns only some route or station records | Render the valid subset and identify the incomplete response; do not manufacture zero-delay values for missing entities. |
| A browser loses network access | Keep the last rendered state with a visible offline or stale indicator and resume polling when connectivity returns. |
| Map tiles or geographic assets fail | Preserve list, table, and detail views so the operational data remains usable without the map. |
| The feed contains no active trips during a valid service period | Explain the observation state and feed age; do not label the network “clear” without a defined interpretation. |

### Implementation Touch Points

- `apps/web/` - Live, route, station, and alert screens.
- `apps/web/components/` - trip, station, alert, freshness, and stale-state presentation.
- `apps/web/lib/` - API client, refresh policy, and shared view models.
- `apps/web/api/` or the standalone API service - live route, station, trip, and alert endpoints.
- MapLibre GL or Leaflet integration - geographic rendering after the list and detail experience works.

### Expected Impact

When ingestion is healthy, 90% of live refreshes should display data no more than 60 seconds older than the source feed timestamp under the initial 30-second poll assumption. A stale state should appear after 2 missed or obsolete intervals, and a recovery should be visible on the next successful refresh. These targets are validated with recorded feed timestamps rather than browser clock time alone.

## Part 4: Reliability Analytics and Rankings

### Concept

The analytics experience turns accumulated observations into questions users can compare. Network, route, and station pages present average and median delay, late-arrival rate, delay distribution, time-of-day patterns, weekday comparisons, alert counts, and reliability trends. Ranking pages compare routes or stations over a selected range such as today, 7 days, 30 days, or all collected history.

The system exposes collection maturity as part of the result. During the first collection window, a chart can say that only 3 days of history exist instead of implying that a short sample represents a stable 30-day pattern.

### Why This Approach

Precomputed hourly and daily aggregates are chosen for common dashboards, while raw observations remain available for audit and less common analysis. This balances a responsive public experience with the ability to recompute metrics when a formula changes. The trade-off is that a newly ingested observation may not appear in a daily ranking until the next aggregation run; the API can identify that lag.

Descriptive analytics come before machine learning. Route and station delay, prediction error, and propagation summaries are useful with transparent formulas and can be checked against source data. The trade-off is postponing a more marketable predictive feature until there is enough history to avoid presenting a speculative model as operational truth.

Rankings use a defined sample policy instead of ranking every entity regardless of evidence. A provisional starting point is 100 relevant arrival events per route or station-period, subject to validation during the analytics phase. The trade-off is that a new or lightly observed entity may be omitted temporarily; this is preferable to an unstable “worst station” claim.

### Operational Scenarios

**Sunny Day**

1. A user selects a network, route, or station and chooses a range such as 7 days or 30 days.
2. The API returns metrics with the range, sample count, collection start, last aggregation time, and whether values are source or derived.
3. The user compares delay by route, station, hour, weekday, or trend period.
4. Rankings order entities by the selected metric and show the evidence count behind each row.
5. A detail view links the summary back to the underlying schedule, prediction, and event concepts.

**Failure Modes**

| Failure | Behavior |
|---|---|
| A selected range contains fewer than the accepted evidence threshold | Show “insufficient history” with the observed sample and collection start instead of a definitive ranking. |
| An aggregation job is late | Serve the last completed aggregate with its timestamp and label the result as behind the live collection window. |
| A metric cannot be recomputed because required source values are absent | Return an unavailable metric with a reason; do not substitute zero or the current prediction. |
| An outlier dominates a small sample | Show robust context such as count and median alongside average, and defer a final outlier policy to the open questions. |
| A route or station has no current alert but poor historical performance | Keep alert state and reliability state separate; one does not overwrite the other. |

### Implementation Touch Points

- `packages/analytics/` - metric definitions, formulas, sample policies, and aggregation inputs.
- `apps/worker/src/jobs/` - hourly and daily aggregation schedules.
- `apps/web/api/` or the standalone API service - network, route, station, and ranking queries.
- `apps/web/` - analytics cards, charts, tables, collection maturity, and provenance labels.
- `docs/` - metric dictionary and later API/architecture documentation.

### Expected Impact

After aggregates are available, common network, route, station, and ranking queries should be measured against a provisional P95 response target of 2 seconds. Every metric response should carry a sample count and collection window; a reviewer should be able to reproduce a displayed average from stored source values. The first useful analytics milestone is not a particular delay number: it is a working 24-hour and 7-day comparison whose result changes when the underlying observation fixture changes.

## Part 5: Prediction Accuracy and Delay Propagation

### Concept

This capability turns TransitPulse's preserved prediction history into analysis that the live MTA feed cannot provide by itself. It compares scheduled arrival, predicted arrival, and actual arrival to report schedule delay and prediction error. It can also follow a trip through sequential stops to show where delay begins, grows, or recovers.

The first version remains descriptive. It answers questions such as how often a prediction is within 1 or 2 minutes, which routes have the most stable estimates, and where a delay increased from +2 to +6 minutes. It does not claim to predict the next delay until the dataset and evaluation method justify that claim.

### Why This Approach

The system preserves scheduled, predicted, and actual times as separate values rather than reducing them to one delay field. This supports both schedule adherence and prediction-error analysis, while retaining the evidence needed to explain a disagreement. The trade-off is a wider data model and more explicit null handling.

Event pairing is based on an inferred actual stop event and the prediction history available before that event. This is chosen over treating the final prediction as actual arrival because the two concepts answer different questions. The trade-off is that some trips remain unpaired and therefore unavailable for prediction scoring.

Machine learning is deferred in favor of transparent baselines. A model can be evaluated later against a descriptive baseline using route, station, hour, weekday, current delay, previous-stop delay, headway, and alerts. The trade-off is postponing automation until there is enough labeled history to measure improvement rather than adding complexity for presentation value.

### Operational Scenarios

**Sunny Day**

1. A trip produces multiple predicted arrival observations for a stop.
2. TransitPulse identifies an actual arrival event with a confidence and source context.
3. The analytics job pairs the event with the schedule and the latest eligible prediction.
4. The route or station view reports schedule delay, prediction error, and the sample size.
5. A propagation view compares delay at sequential stops and identifies accumulation or recovery patterns.

**Failure Modes**

| Failure | Behavior |
|---|---|
| No actual arrival can be established | Retain prediction history but exclude the trip from prediction-accuracy scoring. |
| Actual arrival is established but no prior prediction exists | Report schedule adherence only and mark prediction error unavailable. |
| Stop sequence or direction is ambiguous | Exclude the trip from propagation analysis and preserve the reason for exclusion. |
| A prediction changes sharply immediately before arrival | Preserve the drift and show it as prediction behavior; do not smooth away the change without documenting a rule. |
| A route has fewer than 100 paired events in the selected range | Show the paired sample and suppress a comparative accuracy ranking until the evidence threshold is met. |

### Implementation Touch Points

- `apps/worker/src/normalization/` - prediction and event timestamps.
- `packages/analytics/` - event pairing, prediction error, prediction drift, and stop-sequence comparisons.
- `apps/worker/src/jobs/` - periodic scoring and propagation aggregates.
- `apps/web/` and the analytics API - accuracy cards, trend charts, and propagation views.

### Expected Impact

Once at least 100 paired events exist for a route-period, TransitPulse can report the percentage of predictions within ±1 minute and ±2 minutes, the percentage more than 5 minutes wrong, and the sample behind each value. Propagation analysis should identify the first observed stop where delay increased by a configured amount and distinguish missing sequence data from genuine recovery. These are measured outputs, not targets for the subway itself.

## Part 6: Public Analytical Experience and Frontend Framework

### Concept

The public product organizes the system around a small set of repeatable user tasks: inspect the network now, understand a route, understand a station, compare rankings, and inspect historical reliability. The primary navigation is Live, Network, Routes, Stations, and Analytics. A page can be useful even when the map is unavailable because tables, charts, freshness, and data-quality context remain available.

The frontend is a React application regardless of whether the surrounding framework is Next.js. The operational choice is how that React application is delivered: either as a browser-first SPA with an independent API, or as a Next.js App Router application with server rendering and optional server-side capabilities.

### Why This Approach

The decision for the MVP is a browser-first React SPA using a conventional build tool and client-side router, with the worker and API kept independent. This fits the dominant workload: live map interaction, client refreshes, charts, filters, and pages whose useful content arrives from the API. It also allows the web surface to deploy as static assets while the worker and API continue to run separately.

This is a deliberate choice, not an assumption that React alone is a full application platform. [React's current documentation](https://react.dev/learn/creating-a-react-app) recommends starting a new app with a framework, while also documenting a from-scratch approach when a project's constraints are not well served by an existing framework. TransitPulse qualifies for that exception only if the independent API, dynamic dashboard workload, and lack of an initial SEO or server-rendering requirement remain true. The browser-first route, data-fetching, loading, and error choices become explicit product responsibilities rather than hidden framework behavior.

Next.js App Router is the strongest alternative. Its [App Router](https://nextjs.org/docs/app/getting-started) provides file-system routing, layouts, server components, loading and error boundaries, streaming, and [route handlers](https://nextjs.org/docs/app/guides/backend-for-frontend). Those features would be valuable if TransitPulse needed indexable public route pages, server-side access to protected data, a backend-for-frontend, or a substantial amount of content that can render before live data arrives. Next.js can also start as a static export and later move to a Node.js or Docker deployment. The cost is a more complex server/client and caching model for a product whose most important data is dynamic; [full-featured Node.js or Docker deployment](https://nextjs.org/docs/app/getting-started/deploying) requires a runtime server, while static export removes or limits runtime features such as dynamic route handlers. A Next.js server would also be a poor home for the continuous ingestion worker.

The decision is therefore based on the product's operational center of gravity:

| Criterion | React SPA with independent API | Next.js App Router |
|---|---|---|
| Live map and frequent polling | Direct fit; map and polling already run in the browser. | Also fits, but map and polling still become client components. |
| Historical route/station deep links | React Router can provide stable URLs and client navigation. | File-system routes, layouts, and prefetching are built in. |
| Initial HTML and SEO | Requires client rendering or a later rendering addition. | Stronger default path for server-rendered or statically generated public pages. |
| API and worker separation | Clear boundary; the web bundle is not a server process. | Possible, but co-located route handlers can blur the boundary unless intentionally restricted. |
| Deployment | Static web hosting plus independent API and worker. | Node/Docker or static export; full features add a runtime and cache/deployment concerns. |
| First-version complexity | More explicit choices for routing, data fetching, and metadata. | More conventions and server/client boundaries to learn and operate. |
| Future server-side capabilities | Requires a deliberate migration or a separate server-rendered surface. | Available within the application if the operational need appears. |
| Portfolio signal for this project | Emphasizes API-first data-product separation and browser performance. | Emphasizes a current full-stack React framework and integrated delivery. |

The accepted trade-off is that the React SPA may need a later rendering or framework decision if public discoverability becomes important. The reversal trigger is concrete: choose Next.js when the product needs server-side secrets or a backend-for-frontend, when three or more public analytical page families benefit from indexable initial HTML, or when measured client-first load and navigation performance misses the agreed target on the intended audience's networks. Until then, Next.js adds capability that the live data path does not require.

### Operational Scenarios

**Sunny Day**

1. A visitor opens a stable route or station URL and receives the application shell.
2. The page fetches the relevant live or historical API data and shows a loading state that explains what is being requested.
3. The visitor moves between Live, Routes, Stations, and Analytics without losing the selected range or context unnecessarily.
4. The application shows charts, tables, and map interactions using the same freshness and provenance vocabulary.
5. A user can share a route, station, or ranking URL without requiring the ingestion process to run inside the browser session.

**Failure Modes**

| Failure | Behavior |
|---|---|
| JavaScript fails to load | The deployment exposes a useful error page and the API remains independently diagnosable; this does not affect collection. |
| A route or station identifier is invalid | Show a not-found state with navigation back to the relevant index rather than an empty successful page. |
| A chart request is slow or fails | Keep the page shell and other independent panels usable, identify the failed metric, and provide its range and request context. |
| A client-side map library cannot render | Preserve list and detail views and report the map-specific failure. |
| A later requirement introduces SEO or server-only access | Reassess the framework against the documented reversal triggers instead of quietly adding server behavior to the worker or API boundary. |

### Implementation Touch Points

- `apps/web/` - browser-first React product surface and route structure.
- `apps/web/components/` - reusable dashboard, chart, table, freshness, and error presentation.
- `apps/web/lib/` - API client, query state, filters, and URL state.
- `apps/web/api/` or standalone API service - independently deployable data contract.
- `packages/shared/` - types and formatting rules shared by API and web.
- Frontend build and hosting configuration - static web deployment for the MVP decision.

### Expected Impact

The framework choice should keep the first browser milestone focused on user-visible behavior: a visitor can load the dashboard, navigate to a route and station, select a 24-hour or 7-day range, and receive explicit loading, stale, empty, and error states. Measure initial load, route navigation, API wait time, bundle size, and map interaction separately. Revisit Next.js only when the measured product need crosses one of the documented reversal triggers; framework preference alone is not evidence.

## Schema and Data Model Additions

The system introduces reference, observation, event, alert, and aggregate data. The following is the operational model; detailed column constraints and migration mechanics belong in the later architecture and data-model documents.

```text
routes
  route_id             text primary key
  short_name           text
  long_name            text
  route_type           integer
  color                text nullable

stations
  station_id           text primary key
  name                 text
  latitude             numeric
  longitude            numeric

stops
  stop_id              text primary key
  station_id           text references stations(station_id)
  name                 text
  latitude             numeric
  longitude            numeric

trips
  trip_id              text
  service_date         date
  route_id             text references routes(route_id)
  direction_id         text nullable
  start_time           timestamptz nullable
  primary key (trip_id, service_date)

scheduled_stop_times
  trip_id              text
  service_date         date
  stop_id              text references stops(stop_id)
  stop_sequence        integer
  scheduled_arrival    timestamptz
  scheduled_departure  timestamptz nullable
  primary key (trip_id, service_date, stop_id, stop_sequence)

trip_observations
  id                   bigserial primary key
  trip_id              text
  service_date         date
  route_id             text nullable
  observed_at          timestamptz
  feed_timestamp       timestamptz nullable
  ingested_at          timestamptz
  current_stop_id      text nullable
  next_stop_id         text nullable
  source_entity_key    text

stop_time_observations
  id                   bigserial primary key
  trip_id              text
  service_date         date
  stop_id              text
  observed_at          timestamptz
  scheduled_arrival    timestamptz nullable
  predicted_arrival    timestamptz nullable
  delay_seconds        integer nullable
  stop_sequence        integer nullable
  source_entity_key    text

actual_stop_events
  id                   bigserial primary key
  trip_id              text
  service_date         date
  stop_id              text
  actual_arrival       timestamptz nullable
  actual_departure     timestamptz nullable
  schedule_delay_sec   integer nullable
  confidence           text

service_alerts
  alert_id             text primary key
  cause                text nullable
  effect               text nullable
  header               text
  description          text nullable
  active_start         timestamptz nullable
  active_end           timestamptz nullable
  created_at            timestamptz
  updated_at            timestamptz

station_daily_metrics
  station_id            text
  date                  date
  observation_count     integer
  arrival_count         integer
  avg_delay_seconds     numeric nullable
  median_delay_seconds  numeric nullable
  p95_delay_seconds     numeric nullable
  late_arrival_pct      numeric nullable
  avg_prediction_error  numeric nullable

route_daily_metrics
  route_id              text
  date                  date
  observation_count     integer
  arrival_count         integer
  avg_delay_seconds     numeric nullable
  median_delay_seconds  numeric nullable
  p95_delay_seconds     numeric nullable
  late_arrival_pct      numeric nullable
  avg_prediction_error  numeric nullable
```

Operational indexes and relationships:

```text
unique (trip_id, service_date, stop_id, observed_at, source_entity_key)
  Prevents repeated polling from becoming repeated logical observations.

index stop_time_observations (service_date, stop_id, observed_at)
  Supports station and time-range history queries.

index stop_time_observations (service_date, trip_id, stop_sequence, observed_at)
  Supports trip history and delay-propagation analysis.

index trip_observations (route_id, observed_at)
  Supports current route state and freshness views.

index actual_stop_events (stop_id, actual_arrival)
  Supports station arrival metrics and event pairing.

index route_daily_metrics (route_id, date)
index station_daily_metrics (station_id, date)
  Supports route/station trends and selected-range rankings.

alert_routes (alert_id, route_id)
alert_stations (alert_id, station_id)
  Connects service alerts to the entities users can inspect.
```

All historical records are scoped by service date and source context. Derived metrics retain their range, aggregation time, and evidence count at the API boundary. No graph-only relationship or separate simulation state is introduced for the MVP; stop sequence, route, and station relationships remain represented by relational keys and ordered fields.

## Implementation Phases

### Phase 1: Understand One Realtime Feed

- Objective: Prove that one MTA GTFS-Realtime feed can be fetched, decoded, and translated into understandable records.
- Deliverables:
  - TypeScript project and environment configuration.
  - One feed fetch and protobuf decode path.
  - Normalized Trip Update output with route, trip, stop, observed time, prediction, delay, and feed timestamp where available.
  - Captured sample data for repeatable validation.
- Dependencies: MTA endpoint access and a local runtime.
- Gate for Phase 2: A recorded feed sample produces the expected normalized fields across at least 10 distinct trip or stop updates, with decode failures visible.

### Phase 2: Establish Static Transit Reference Data

- Objective: Create the route, station, stop, trip, and schedule context needed to interpret realtime observations.
- Deliverables:
  - Static GTFS import for routes, stations/stops, trips, and scheduled stop times.
  - Service-day normalization across midnight.
  - Referential mismatch report for realtime identities not present in the static snapshot.
- Dependencies: Phase 1's normalized identifiers and a selected static GTFS snapshot.
- Gate for Phase 3: The import can resolve the trip and stop identities in the captured realtime sample, and a trip crossing midnight retains one unambiguous service-day identity.

### Phase 3: Persist Observations with an Independent Worker

- Objective: Run continuous collection independently of browser traffic and store historical observations without obvious duplication.
- Deliverables:
  - PostgreSQL schema and migrations.
  - Realtime ingestion worker with a measured polling cadence.
  - Observation deduplication and restart behavior.
  - Ingestion health values: last success, feed age, parsed, inserted, duplicate, rejected, duration, and error counts.
- Dependencies: Phases 1 and 2; reachable PostgreSQL environment.
- Gate for Phase 4: A 30-minute collection run completes at least 95% of expected cycles, reports its health, and produces no duplicate rows under the selected logical uniqueness rule.

### Phase 4: Produce Trustworthy Metrics and APIs

- Objective: Expose live state and historical delay metrics with enough context for a user to judge their reliability.
- Deliverables:
  - Delay calculations preserving scheduled, predicted, and actual values separately.
  - Live route, station, trip, and alert endpoints.
  - Route/station analytics and ranking endpoints for at least 24-hour and 7-day ranges.
  - API responses containing freshness, range, sample count, collection start, and source/derived labeling.
- Dependencies: Phase 3's stored observations and reference data.
- Gate for Phase 5: Hand-calculated fixtures match API values for average delay, late-arrival rate, and at least one ranking, including the correct behavior for missing values and insufficient samples.

### Phase 5: Deliver the Browser-First Product Surface

- Objective: Make the API useful through a coherent public dashboard before map rendering is complete.
- Deliverables:
  - React browser-first application with stable Live, Network, Routes, Stations, and Analytics navigation.
  - Dashboard, route, station, and ranking views.
  - Loading, empty, stale, insufficient-history, and error states.
  - URL state for selected route, station, metric, and range.
- Dependencies: Phase 4 API contract; framework decision recorded in Part 6.
- Gate for Phase 6: A user can navigate from the dashboard to a route and station, select 24-hour and 7-day ranges, and distinguish live source data from calculated metrics without inspecting developer tools.

### Phase 6: Add the Live Map and Operational Hardening

- Objective: Add geographic context and make the end-to-end product resilient to partial failures.
- Deliverables:
  - Route and station map overlay.
  - Clickable train and station details where data supports them.
  - Client freshness policy tied to source and ingestion timestamps.
  - Operator health view or equivalent diagnostic surface.
  - Basic retention, aggregation cadence, pagination, and query-cost controls.
- Dependencies: Phase 5's working list/detail experience and Phase 3's health data.
- Gate for Phase 7: Under a controlled stale-feed or tile-failure scenario, the system preserves usable list and historical views, shows stale state after 2 obsolete intervals, and recovers on the next valid ingestion.

### Phase 7: Expand Historical Insight

- Objective: Add prediction accuracy, delay propagation, replay, alert analytics, and other stretch features only after the dataset supports them.
- Deliverables:
  - Actual-event pairing and prediction accuracy summaries.
  - Sequential stop delay-propagation views.
  - Historical replay or heatmap experiments.
  - Documented reliability score only if its components and evidence are transparent.
- Dependencies: Phase 6 and enough paired events for the selected analysis; a 30-day history is a useful initial maturity target, not an automatic guarantee of validity.
- Gate for additional modeling: At least 100 paired events for each compared route-period, reproducible baseline metrics, and a written definition of what a model improves over.

## Design Decisions

| Decision | Rationale |
|---|---|
| Start with MTA static GTFS and one subway GTFS-Realtime feed | Proves the complete `MTA → ingestion → database → analytics → API → UI` path before feed breadth creates identity and operational noise. |
| Run ingestion as an independent worker | Collection must continue when the website has zero users; tying it to web requests would make the historical dataset depend on browser traffic. |
| Use PostgreSQL first | Time, trip, route, stop, schedule, and aggregate queries are relational and temporal. Neo4j and TimescaleDB remain possible later choices, not MVP prerequisites. |
| Treat observations and actual events as different records | Repeated predictions describe changing state; an arrival is an event. Combining them would corrupt counts and prediction-error analysis. |
| Include `service_date` in trip identity | Feed trip identifiers can be reused and subway service crosses midnight. A trip identifier alone is not a safe historical key. |
| Preserve scheduled, predicted, and actual times separately | One delay field cannot support schedule adherence, prediction error, and prediction drift at the same time. |
| Keep raw observations and aggregate metrics separate | Raw rows preserve auditability; hourly and daily aggregates keep common dashboards from repeatedly scanning telemetry history. |
| Use a browser-first React SPA for the MVP | The primary workload is a dynamic map and dashboard backed by an independent API. Static web deployment reduces runtime coupling while keeping routes and deep links possible. |
| Do not adopt Next.js solely because it is listed in the project spec | Next.js is a strong alternative for SSR, SEO, server-only access, or a backend-for-frontend. Those benefits are not yet demonstrated needs; the reversal triggers are recorded in Part 6. |
| Keep the API as a product boundary | The browser, future consumers, and analytics jobs receive consistent freshness, provenance, and error semantics without direct database coupling. |
| Favor descriptive analytics before machine learning or a digital twin | Transparent delay and prediction metrics can be validated with the first historical dataset; simulations and models require evidence and additional scope. |
| Do not block backend value on perfect map rendering | The dataset, API, route pages, station pages, and rankings prove the core product even when geographic assets or map libraries fail. |

## Test Strategy

**Phase 1 - Feed understanding**

- Verify decoding and normalization against captured feed samples. Pass when at least 10 expected trip/stop records retain route, trip, stop, and timing identity; failure means the parser silently drops or fabricates operational fields.

**Phase 2 - Static reference data**

- Verify route, station, stop, trip, and scheduled-time relationships, including a midnight-crossing trip. Pass when all fixture references resolve or appear in the mismatch report; failure means an observation is assigned to the wrong service day or silently discarded.

**Phase 3 - Persistence and worker**

- Verify repeated polls, worker restarts, stale feeds, malformed responses, and partial records. Pass when a 30-minute run meets the 95% cycle target, duplicates are accounted for, and health values explain every failure; failure means the worker stops collecting, inflates history, or reports healthy while the feed is stale.

**Phase 4 - Metrics and APIs**

- Verify formulas against hand-calculated fixtures for schedule delay, predicted delay, average, median, late rate, and ranking thresholds. Pass when source values and derived values remain distinguishable and insufficient samples are handled explicitly; failure means a missing value becomes zero or a ranking cannot be traced to evidence.

**Phase 5 - Browser product**

- Verify navigation, URL state, loading, empty, stale, insufficient-history, and error states using controlled API responses. Pass when a user can identify the range, freshness, and provenance of every displayed metric; failure means a failed panel blanks unrelated content or a stale result looks current.

**Phase 6 - Map and hardening**

- Verify partial route data, tile failure, API delay, two missed refresh intervals, and recovery. Pass when list and historical views remain useful without the map and the stale indicator appears after the defined 2-interval threshold; failure means a visual dependency hides valid operational data.

**Phase 7 - Historical insight**

- Verify event pairing, prediction accuracy, drift, and stop-sequence propagation using fixtures with known arrivals, missing predictions, and changing estimates. Pass when each result includes its paired sample and excludes unsupported trips; failure means predicted arrival is presented as actual arrival or a low-sample comparison is ranked as authoritative.

## Open Questions

- Which specific MTA GTFS and GTFS-Realtime endpoints, credentials, and usage limits apply to the initial deployment? This is deferred until the first feed experiment confirms the available entities and operational terms.
- What polling cadence best balances freshness, source limits, ingestion cost, and row volume? The current 30-second value is a starting assumption from the project specification and needs measured feed-age and rows-per-day data.
- What evidence rule establishes an actual arrival or departure from successive realtime observations? This is deferred because event inference affects every delay and prediction-accuracy metric.
- What minimum sample threshold and late-arrival definition should govern route and station rankings? The initial 100-event threshold and selected delay cutoffs are provisional until real distributions are observed.
- How long should raw observations be retained, and what storage budget supports that window? This is deferred until the worker measures daily volume, duplicate rate, and aggregate coverage.
- Does the first public audience need SEO or server-rendered initial HTML? If yes, the React SPA decision should be revisited against the Next.js reversal triggers; if no, the simpler independent web deployment remains the better operational fit.
- Which alert-to-route and alert-to-station relationships are consistently present in the source feed? This is deferred until representative service-alert samples show whether the join tables can be populated reliably.
- What evidence is sufficient to label an inferred stop event as high confidence? This is deferred until missing updates, service changes, and trips that disappear from the feed have been observed in collection.
