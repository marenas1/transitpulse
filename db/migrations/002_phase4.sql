CREATE TABLE IF NOT EXISTS service_alerts (
  feed_name text NOT NULL,
  alert_id text NOT NULL,
  header_text text NOT NULL,
  description_text text,
  cause text,
  effect text,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  feed_timestamp timestamptz,
  PRIMARY KEY (feed_name, alert_id)
);

ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS alerts_seen integer NOT NULL DEFAULT 0;

ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS alerts_upserted integer NOT NULL DEFAULT 0;

ALTER TABLE stop_time_observations
  ADD COLUMN IF NOT EXISTS actual_arrival timestamptz;

CREATE TABLE IF NOT EXISTS alert_routes (
  feed_name text NOT NULL,
  alert_id text NOT NULL,
  route_id text NOT NULL REFERENCES routes(route_id),
  PRIMARY KEY (feed_name, alert_id, route_id),
  FOREIGN KEY (feed_name, alert_id)
    REFERENCES service_alerts(feed_name, alert_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS route_daily_metrics (
  metric_date date NOT NULL,
  route_id text NOT NULL REFERENCES routes(route_id),
  observation_count integer NOT NULL,
  delay_sample_count integer NOT NULL,
  late_observation_count integer NOT NULL,
  average_delay_seconds numeric,
  median_delay_seconds numeric,
  p95_delay_seconds numeric,
  late_rate numeric,
  aggregate_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, route_id)
);

CREATE TABLE IF NOT EXISTS station_daily_metrics (
  metric_date date NOT NULL,
  station_id text NOT NULL REFERENCES stations(station_id),
  observation_count integer NOT NULL,
  delay_sample_count integer NOT NULL,
  late_observation_count integer NOT NULL,
  average_delay_seconds numeric,
  median_delay_seconds numeric,
  p95_delay_seconds numeric,
  late_rate numeric,
  aggregate_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, station_id)
);

CREATE INDEX IF NOT EXISTS idx_service_alerts_last_seen
  ON service_alerts (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_route_daily_metrics_date
  ON route_daily_metrics (metric_date DESC, route_id);

CREATE INDEX IF NOT EXISTS idx_station_daily_metrics_date
  ON station_daily_metrics (metric_date DESC, station_id);

INSERT INTO schema_migrations (version)
VALUES ('002_phase4')
ON CONFLICT (version) DO NOTHING;
