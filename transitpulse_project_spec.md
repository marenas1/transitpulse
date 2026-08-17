# TransitPulse — NYC Subway Observability & Analytics Platform

## 1. Project Overview

**TransitPulse** is a real-time NYC subway data platform that continuously ingests MTA GTFS and GTFS-Realtime feeds, stores historical observations, and turns them into live operational views and reliability analytics.

The project is intentionally **not** a simulation or digital twin. Its core value is building a historical dataset from continuously changing public transit data and using that dataset to answer questions the live MTA feed alone cannot answer.

Examples:

- Which subway stations experience the most delays?
- Which routes are least reliable?
- What times of day have the worst delays?
- How accurate are MTA arrival predictions?
- Which stations see the most service disruptions?
- How do delays evolve as a train moves through its route?
- Which routes or stations improve or degrade week over week?

The application combines:

- real-time data ingestion
- time-series / historical storage
- backend data processing
- analytics
- geospatial visualization
- public API integration
- modern frontend development

---

## 2. Core Product Idea

The MTA provides current transit state through GTFS and GTFS-Realtime.

TransitPulse repeatedly records that state.

Over time:

```text
MTA Live Feed
      ↓
Observation
      ↓
Observation
      ↓
Observation
      ↓
Observation
      ↓
Historical Dataset
      ↓
Analytics + Trends + Rankings
```

The live map provides immediate visual value.

The historical database is the main engineering differentiator.

---

## 3. Product Goals

### Primary Goals

1. Display a live view of NYC subway activity.
2. Continuously ingest MTA GTFS-Realtime data.
3. Persist historical train / stop observations.
4. Calculate delay and reliability metrics.
5. Rank stations and routes by historical performance.
6. Provide route-level and station-level analytics.
7. Clearly distinguish source data from metrics calculated by TransitPulse.

### Non-Goals for MVP

Do not initially build:

- disruption simulations
- a full digital twin
- ML prediction models
- passenger-count estimation
- exact crowding estimates
- every possible MTA feed
- a complex microservices architecture

The MVP should first prove the full pipeline:

```text
MTA → Ingestion → Database → Analytics → API → UI
```

---

## 4. Proposed Stack

### Frontend

- Next.js
- TypeScript
- React
- Tailwind CSS

Potential map libraries:

- MapLibre GL
- Leaflet
- Mapbox GL if desired

### Backend

Initial recommendation:

- TypeScript
- Node.js
- Next.js API routes or a small standalone backend service

A separate ingestion worker should run independently of frontend requests.

### Database

**PostgreSQL**

Postgres fits this project better than Neo4j because the dominant data is temporal and relational:

```text
trip
station
route
timestamp
scheduled arrival
predicted arrival
observed arrival
delay
```

Possible future addition:

- TimescaleDB

Do not introduce TimescaleDB until standard PostgreSQL becomes limiting.

### Deployment

Possible architecture:

```text
Frontend / API
    ↓
Vercel / Render / Railway

Ingestion Worker
    ↓
Railway / Render / Fly.io / AWS

PostgreSQL
    ↓
Neon / Supabase / Railway / AWS RDS
```

The ingestion worker must run continuously even when nobody is using the site.

---

## 5. Data Sources

### GTFS Static

Use the MTA static GTFS feeds for relatively stable schedule and topology information such as:

- routes
- stations
- stops
- trips
- stop sequences
- scheduled stop times

This data should populate reference tables.

### GTFS-Realtime

Use MTA GTFS-Realtime for continuously changing operational information.

Important entities include:

- Trip Updates
- Stop Time Updates
- Service Alerts
- vehicle / trip state where available

The ingestion service should poll the feed periodically and convert protobuf feed entities into normalized database records.

---

## 6. High-Level Architecture

```text
                     ┌────────────────────┐
                     │      MTA APIs      │
                     │ GTFS + GTFS-RT     │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │  Ingestion Worker  │
                     │                    │
                     │ Fetch              │
                     │ Decode Protobuf    │
                     │ Normalize          │
                     │ Validate           │
                     │ Deduplicate        │
                     └─────────┬──────────┘
                               │
                               ▼
                     ┌────────────────────┐
                     │     PostgreSQL     │
                     │                    │
                     │ Static GTFS        │
                     │ Live Observations  │
                     │ Alerts             │
                     │ Aggregates         │
                     └─────────┬──────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
       ┌─────────────────┐          ┌──────────────────┐
       │    Live API     │          │  Analytics API   │
       └────────┬────────┘          └────────┬─────────┘
                │                             │
                └──────────────┬──────────────┘
                               ▼
                     ┌────────────────────┐
                     │      Next.js       │
                     │                    │
                     │ Live Map           │
                     │ Route Analytics    │
                     │ Station Analytics  │
                     │ Network Dashboard  │
                     └────────────────────┘
```

---

## 7. Suggested Database Model

Start simple.

### routes

```text
route_id
short_name
long_name
route_type
color
```

### stations

```text
station_id
name
latitude
longitude
```

### stops

A station may contain multiple directional / platform-level stops.

```text
stop_id
station_id
name
latitude
longitude
```

### trips

```text
trip_id
route_id
service_date
direction_id
start_time
```

Because trip IDs may be reused across service days, avoid assuming `trip_id` alone is globally unique across historical data.

A useful logical key may include:

```text
trip_id + service_date
```

### scheduled_stop_times

```text
trip_id
service_date
stop_id
stop_sequence
scheduled_arrival
scheduled_departure
```

### trip_observations

Each ingestion cycle records the current state of a trip.

```text
id
trip_id
service_date
route_id
observed_at
current_stop_id
next_stop_id
```

### stop_time_observations

This table is likely to become one of the most important tables.

```text
id
trip_id
service_date
stop_id
observed_at
scheduled_arrival
predicted_arrival
delay_seconds
stop_sequence
```

Example:

```text
trip_id:          092300_2..N08R
stop_id:          127N
observed_at:      2026-08-17 17:32:00
scheduled_arrival:17:38:00
predicted_arrival:17:42:00
delay_seconds:    240
```

### actual_stop_events

When TransitPulse determines that a train has arrived / departed a station:

```text
id
trip_id
service_date
stop_id
actual_arrival
actual_departure
schedule_delay_seconds
```

### service_alerts

```text
alert_id
cause
effect
header
description
active_start
active_end
created_at
updated_at
```

Relationships between alerts, routes, and stations can be stored using join tables.

Examples:

```text
alert_routes
alert_stations
```

---

## 8. Important Concept: Observation vs Event

Do not treat every GTFS-Realtime record as a unique transit event.

If the feed is polled every 30 seconds:

```text
10:00:00 predicted arrival → 10:08
10:00:30 predicted arrival → 10:08
10:01:00 predicted arrival → 10:09
10:01:30 predicted arrival → 10:10
```

These are **observations** of a changing prediction.

The actual train arrival is an **event**.

Keeping this distinction will make the data model much cleaner.

---

## 9. Delay Calculation

One useful derived metric:

```text
delay = predicted_arrival - scheduled_arrival
```

Example:

```text
Scheduled: 10:42
Predicted: 10:47

Delay: +5 minutes
```

However, TransitPulse should preserve all three values:

```text
scheduled arrival
predicted arrival
actual arrival
```

This enables different metrics.

### Schedule Delay

```text
actual arrival - scheduled arrival
```

### Prediction Error

```text
actual arrival - predicted arrival
```

### Prediction Drift

How much a prediction changes over time.

Example:

```text
10:30 → predicted 10:40
10:34 → predicted 10:42
10:37 → predicted 10:44
actual → 10:45
```

TransitPulse can later analyze how stable countdown estimates are.

---

## 10. Core Application Views

## 10.1 Live Network

The main visual entry point.

Display:

- subway lines
- stations
- currently active trips where feasible
- train / trip state
- delays
- current alerts

Clicking a train should show:

```text
Route: 2
Direction: Uptown

Previous Stop: 34 St
Next Stop: Times Sq

Scheduled: 10:42
Predicted: 10:46
Current Delay: +4 min
```

Clicking a station should show:

- routes serving it
- incoming trains
- current delays
- active alerts

---

## 10.2 Network Analytics

Example cards:

```text
Average Delay
2.8 min

Most Delayed Route
C

Most Delayed Station
125 St

Routes With Active Alerts
4
```

Charts could include:

- average delay by route
- average delay by hour
- delay by weekday
- route reliability over time
- delay distribution
- number of active alerts over time

---

## 10.3 Route Analytics

Example:

```text
C TRAIN

30-Day Average Delay: 5.8 min
Late Stop Events: 29%
Worst Hour: 5–6 PM
Best Hour: 11 AM–12 PM
Most Delayed Station: 125 St
```

Charts:

- delay over time
- delay by station
- delay by hour
- weekday comparison
- historical reliability trend

---

## 10.4 Station Analytics

Example:

```text
125 ST

Routes:
A C B D

30-Day Average Delay:
6.8 min

Morning Rush:
4.2 min

Evening Rush:
8.4 min

Late Arrival Rate:
31%
```

Additional metrics:

- most delayed route through station
- best / worst hours
- average prediction error
- number of service alerts
- delay trend

---

## 10.5 Rankings

Example pages:

### Most Delayed Stations

```text
1. 125 St                 6.8 min
2. Times Sq–42 St         5.9 min
3. 59 St–Columbus Circle  5.5 min
4. Atlantic Av            5.1 min
```

### Most Delayed Routes

```text
1. C   6.2 min
2. 2   4.8 min
3. A   4.1 min
4. 1   2.7 min
```

Allow ranges such as:

```text
Today
7 Days
30 Days
All Time
```

---

## 11. Prediction Accuracy

A particularly interesting TransitPulse-specific feature is analyzing the quality of countdown predictions.

Example:

```text
When the MTA says a train is 5 minutes away:

Within ±1 minute: 71%
Within ±2 minutes: 89%
More than 5 min wrong: 2%
```

Possible rankings:

```text
Most Accurate Routes

1 Train    91%
7 Train    89%
L Train    87%
```

This creates insight from historical observations rather than merely re-displaying public feed values.

---

## 12. Historical Delay Propagation

Eventually, TransitPulse can inspect how delays evolve along a trip.

Example observed history:

```text
96 St       +1 min
72 St       +2 min
Times Sq    +4 min
34 St       +5 min
14 St       +6 min
```

This could support questions like:

- Where do trains most often begin accumulating delay?
- Which stations tend to recover delay?
- Which segments contribute most to worsening delays?

This should initially be descriptive analytics rather than predictive modeling.

---

## 13. Data Aggregation

Raw observations may become large quickly.

If:

```text
1 observation / train / stop update / 30 seconds
```

is stored indefinitely, the dataset will grow substantially.

Use separate raw and aggregate data.

Possible structure:

```text
RAW
stop_time_observations

        ↓ scheduled job

HOURLY
station_hourly_metrics
route_hourly_metrics

        ↓

DAILY
station_daily_metrics
route_daily_metrics
```

Example aggregate table:

### station_daily_metrics

```text
station_id
date
observation_count
arrival_count
avg_delay_seconds
median_delay_seconds
p95_delay_seconds
late_arrival_percentage
avg_prediction_error_seconds
```

This allows analytics queries to remain fast without repeatedly scanning raw telemetry.

---

## 14. Background Jobs

TransitPulse will need multiple types of work.

### Realtime Ingestion

Runs frequently.

```text
fetch → decode → normalize → deduplicate → insert
```

### Static GTFS Import

Runs less frequently.

```text
download GTFS
↓
parse routes/stops/trips/schedules
↓
upsert reference tables
```

### Aggregation Job

Example cadence:

```text
every hour
```

Calculate hourly metrics.

### Cleanup / Retention Job

Optional later.

For example:

```text
raw observations → retain 30–90 days
aggregated metrics → retain indefinitely
```

---

## 15. Backend API

Example routes.

### Live

```text
GET /api/live/routes
GET /api/live/routes/:routeId
GET /api/live/stations/:stationId
GET /api/live/trips/:tripId
GET /api/live/alerts
```

### Analytics

```text
GET /api/analytics/network
GET /api/analytics/routes
GET /api/analytics/routes/:routeId
GET /api/analytics/stations
GET /api/analytics/stations/:stationId
```

Potential query parameters:

```text
?range=24h
?range=7d
?range=30d
```

### Rankings

```text
GET /api/rankings/routes?metric=avg_delay
GET /api/rankings/stations?metric=avg_delay
```

---

## 16. Suggested Repository Structure

A monorepo is reasonable.

```text
transitpulse/
│
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   └── api/
│   │
│   └── worker/
│       ├── src/
│       │   ├── feeds/
│       │   ├── gtfs/
│       │   ├── realtime/
│       │   ├── normalization/
│       │   ├── jobs/
│       │   └── db/
│       └── package.json
│
├── packages/
│   ├── db/
│   │   ├── schema/
│   │   └── migrations/
│   │
│   ├── shared/
│   │   ├── types/
│   │   └── utils/
│   │
│   └── analytics/
│
├── docs/
│   ├── architecture.md
│   └── data-model.md
│
├── docker-compose.yml
└── README.md
```

Do not over-optimize the repository architecture early.

A simpler initial structure is also fine:

```text
src/
worker/
db/
```

The important part is separating continuous ingestion from user-request-driven API work.

---

## 17. MVP Scope

The MVP should prove an end-to-end vertical slice.

### Phase 1 — Understand the Data

- Fetch one MTA subway GTFS-Realtime feed.
- Decode protobuf.
- Print normalized Trip Updates.
- Identify trip IDs, route IDs, stops, timestamps, and arrival predictions.

### Phase 2 — Static GTFS

- Import routes.
- Import stations / stops.
- Import trips.
- Import scheduled stop times.

### Phase 3 — Persistence

- Create PostgreSQL database.
- Store realtime stop observations.
- Prevent obvious duplicate records.
- Associate observations with trips / routes / stops.

### Phase 4 — Delay Metrics

Calculate:

- scheduled arrival
- predicted arrival
- predicted delay
- route average delay
- station average delay

### Phase 5 — Basic API

Build endpoints for:

- live route state
- live station state
- route analytics
- station analytics
- rankings

### Phase 6 — Frontend

Build:

- dashboard shell
- live view
- station page
- route page
- analytics page

### Phase 7 — Live Map

Overlay operational data on the subway network.

Do not block the backend MVP on perfect map visualization.

---

## 18. Stretch Features

After the core system is working:

### Historical Replay

Allow a user to select:

```text
August 12
5:30 PM
```

and replay the network state from stored observations.

This would be a particularly strong portfolio feature because historical state is created by TransitPulse's own data collection.

### Prediction Accuracy

Compare earlier countdown estimates to actual observed arrivals.

### Delay Heatmap

Display stations geographically using color / intensity based on:

- average delay
- late arrival rate
- alert frequency

### Reliability Score

Create a clearly documented score based on metrics such as:

```text
schedule adherence
delay variance
prediction accuracy
service alert frequency
```

Avoid presenting the score as an official MTA metric.

### Historical Comparisons

```text
This week vs last week
Weekday vs weekend
Morning vs evening rush
Route vs route
```

### Alert Analytics

Analyze:

- common alert causes
- routes most frequently affected
- average duration
- time-of-day distribution

### Delay Propagation Analysis

Analyze how delays change across sequential stops.

### Machine Learning

Only after enough historical data exists.

Potential model:

```text
route
station
hour
weekday
current delay
previous stop delay
headway
active alerts

        ↓

predicted next-stop delay
```

ML should remain optional.

The project is already technically strong without it.

---

## 19. Engineering Challenges Worth Highlighting

Part of the portfolio value comes from solving real data-system problems.

Expected challenges include:

### Duplicate Data

GTFS-Realtime is repeatedly publishing updated state.

TransitPulse must avoid treating every repeated record as a unique event.

### Missing Data

Trips or predictions may temporarily disappear.

Do not automatically assume disappearance means cancellation.

### Service-Day Boundaries

Subway service runs across midnight.

A service day may not map cleanly to a calendar date.

### Trip Identity

Trip IDs may need additional service-date context.

### Prediction Changes

Arrival predictions change over time.

Preserve history rather than overwriting previous predictions.

### Data Volume

Continuous ingestion can create millions of observations.

Plan for:

- indexes
- retention
- aggregation
- pagination
- efficient queries

### Feed Latency

Store both:

```text
feed timestamp
ingestion timestamp
```

when possible.

This makes it possible to distinguish source latency from application latency.

---

## 20. Observability

Because this is itself an observability project, the ingestion system should expose its own operational health.

Track:

```text
last successful ingestion
feed age
records processed
records inserted
duplicates ignored
ingestion duration
errors
```

Example internal dashboard:

```text
INGESTION HEALTH

Last Fetch       12 sec ago
Feed Age          8 sec
Trips Parsed      384
Rows Inserted     921
Duplicates        143
Duration          412 ms
Status            Healthy
```

This is a strong backend engineering detail for interviews.

---

## 21. Potential User Experience

Main navigation:

```text
TransitPulse

Live
Network
Routes
Stations
Analytics
```

Home dashboard:

```text
NYC SUBWAY STATUS
──────────────────────────────

Live Trips          XXX
Average Delay       X.X min
Active Alerts       XX
Worst Route         X
Worst Station       XXXXX

[Live Network Map]

Route Performance

A   ███████      3.4m
C   ██████████   5.2m
1   ████         2.1m
2   ████████     4.3m

Most Delayed Stations

1. XXXXX
2. XXXXX
3. XXXXX
```

Avoid filling the UI with metrics until enough historical data exists.

During initial collection, explicitly display:

```text
Historical data collection began:
August XX, 2026
```

This keeps the analytics honest.

---

## 22. Portfolio Story

The project should be presented as a **data platform**, not simply a transit tracker.

Weak description:

> Built an app that displays NYC subway arrival times.

Strong description:

> Built a real-time NYC subway observability platform that continuously ingests and normalizes MTA GTFS-Realtime feeds, persists historical transit observations in PostgreSQL, and derives route- and station-level reliability analytics from time-series data.

The engineering story includes:

- public API ingestion
- protobuf / GTFS parsing
- scheduled background workers
- data normalization
- relational schema design
- time-series storage
- deduplication
- aggregation pipelines
- API design
- geospatial visualization
- frontend analytics
- production deployment

---

## 23. Initial Resume Bullet Direction

Once implemented and measured, a future resume bullet could resemble:

> Built a real-time NYC subway analytics platform using TypeScript, Next.js, and PostgreSQL, continuously ingesting MTA GTFS-Realtime feeds to track train performance and derive historical route and station reliability metrics.

A second bullet could eventually emphasize scale:

> Designed a background ingestion and aggregation pipeline processing **X+ daily transit observations**, enabling historical delay rankings, time-of-day analysis, and arrival-prediction accuracy metrics across **Y routes / Z stations**.

Do not invent X, Y, or Z before measuring them.

---

## 24. Recommended First Coding Session

The first implementation milestone should be deliberately small.

### Goal

Successfully fetch and understand one realtime MTA feed.

### Tasks

1. Initialize TypeScript project.
2. Add environment configuration.
3. Fetch one subway GTFS-Realtime endpoint.
4. Decode the protobuf response.
5. Extract several Trip Updates.
6. Normalize each into a TypeScript object.
7. Log:

```text
route
trip
stop
scheduled / predicted time if available
delay if provided
feed timestamp
```

8. Save sample normalized output for tests.
9. Only then begin designing the permanent database ingestion path.

### First Success Criterion

The first milestone is complete when the application can produce understandable structured output similar to:

```json
{
  "routeId": "2",
  "tripId": "...",
  "stopId": "127N",
  "observedAt": "...",
  "predictedArrival": "...",
  "delaySeconds": 180
}
```

from a real MTA feed.

---

## 25. Guiding Principle

Every major feature should answer one of two questions:

### What is happening now?

Handled by the live feed and live map.

### What usually happens?

Handled by TransitPulse's historical database and analytics.

That distinction should remain central to the architecture and user experience.

---

## 26. MVP Definition of Done

The first portfolio-ready version is complete when TransitPulse can:

- continuously consume a real MTA GTFS-Realtime subway feed
- store historical observations in PostgreSQL
- combine realtime observations with static schedule information
- calculate meaningful delay metrics
- display current subway information
- rank routes and stations using collected historical data
- show historical trends over selectable time ranges
- expose at least one geographically useful live network visualization
- run its ingestion worker independently of user traffic
- clearly document how each calculated metric is derived

At that point, TransitPulse is already a substantial full-stack + data-engineering portfolio project.
