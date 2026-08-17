CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routes (
  route_id text PRIMARY KEY,
  short_name text NOT NULL,
  long_name text NOT NULL,
  route_type integer,
  color text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stations (
  station_id text PRIMARY KEY,
  name text NOT NULL,
  latitude numeric,
  longitude numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stops (
  stop_id text PRIMARY KEY,
  station_id text REFERENCES stations(station_id),
  name text NOT NULL,
  latitude numeric,
  longitude numeric,
  location_type integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  static_trip_id text PRIMARY KEY,
  realtime_trip_id_suffix text NOT NULL,
  route_id text NOT NULL REFERENCES routes(route_id),
  service_id text NOT NULL,
  direction_id text,
  headsign text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_stop_times (
  static_trip_id text NOT NULL REFERENCES trips(static_trip_id),
  stop_id text NOT NULL REFERENCES stops(stop_id),
  stop_sequence integer NOT NULL,
  arrival_time text NOT NULL,
  departure_time text NOT NULL,
  arrival_seconds integer NOT NULL,
  departure_seconds integer NOT NULL,
  PRIMARY KEY (static_trip_id, stop_id, stop_sequence)
);

CREATE TABLE IF NOT EXISTS trip_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_name text NOT NULL,
  source_trip_id text NOT NULL,
  static_trip_id text REFERENCES trips(static_trip_id),
  service_date date NOT NULL,
  route_id text REFERENCES routes(route_id),
  current_stop_id text REFERENCES stops(stop_id),
  observed_at timestamptz NOT NULL,
  feed_timestamp timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  direction_id text,
  start_time text,
  source_entity_key text NOT NULL,
  UNIQUE (feed_name, feed_timestamp, source_entity_key)
);

CREATE TABLE IF NOT EXISTS stop_time_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_name text NOT NULL,
  source_trip_id text NOT NULL,
  static_trip_id text REFERENCES trips(static_trip_id),
  service_date date NOT NULL,
  route_id text REFERENCES routes(route_id),
  stop_id text NOT NULL REFERENCES stops(stop_id),
  observed_at timestamptz NOT NULL,
  feed_timestamp timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  scheduled_arrival timestamptz,
  predicted_arrival timestamptz,
  delay_seconds integer,
  stop_sequence integer,
  source_entity_key text NOT NULL,
  UNIQUE (feed_name, feed_timestamp, source_entity_key)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  feed_timestamp timestamptz,
  fetched_at timestamptz,
  http_status integer,
  bytes_received integer,
  entities_seen integer NOT NULL DEFAULT 0,
  trip_updates_seen integer NOT NULL DEFAULT 0,
  stop_updates_seen integer NOT NULL DEFAULT 0,
  trip_observations_inserted integer NOT NULL DEFAULT 0,
  stop_observations_inserted integer NOT NULL DEFAULT 0,
  duplicates_ignored integer NOT NULL DEFAULT 0,
  unresolved_reference_records integer NOT NULL DEFAULT 0,
  rejected_records integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  error_message text
);

ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS unresolved_reference_records integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_trip_observations_route_time
  ON trip_observations (route_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trip_observations_trip_time
  ON trip_observations (source_trip_id, service_date, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stop_observations_stop_time
  ON stop_time_observations (stop_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stop_observations_trip_sequence
  ON stop_time_observations (source_trip_id, service_date, stop_sequence, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_feed_time
  ON ingestion_runs (feed_name, started_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('001_phase3')
ON CONFLICT (version) DO NOTHING;
