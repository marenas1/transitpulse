export const LATE_THRESHOLD_SECONDS = 300;
export const DEFAULT_MINIMUM_RANKING_SAMPLES = 100;

export type MetricSample = {
  entityId: string;
  entityName: string;
  observedAt: string;
  delaySeconds: number | null;
};

export type MetricSummary = {
  observationCount: number;
  delaySampleCount: number;
  lateObservationCount: number;
  averageDelaySeconds: number | null;
  medianDelaySeconds: number | null;
  p95DelaySeconds: number | null;
  lateRate: number | null;
  status: "available" | "insufficient_history" | "unavailable";
};

export type RankedMetric = {
  rank: number;
  entityId: string;
  entityName: string;
  metrics: MetricSummary;
};

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const position = (values.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

export function summarizeSamples(
  samples: MetricSample[],
  minimumSamples = 1,
): MetricSummary {
  const usable = samples
    .map((sample) => sample.delaySeconds)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  const observationCount = samples.length;
  const delaySampleCount = usable.length;
  const lateObservationCount = usable.filter(
    (value) => value >= LATE_THRESHOLD_SECONDS,
  ).length;

  if (delaySampleCount === 0) {
    return {
      observationCount,
      delaySampleCount,
      lateObservationCount: 0,
      averageDelaySeconds: null,
      medianDelaySeconds: null,
      p95DelaySeconds: null,
      lateRate: null,
      status: "unavailable",
    };
  }

  const sum = usable.reduce((total, value) => total + value, 0);
  return {
    observationCount,
    delaySampleCount,
    lateObservationCount,
    averageDelaySeconds: rounded(sum / delaySampleCount),
    medianDelaySeconds: rounded(percentile(usable, 0.5) ?? 0),
    p95DelaySeconds: rounded(percentile(usable, 0.95) ?? 0),
    lateRate: rounded(lateObservationCount / delaySampleCount),
    status: delaySampleCount < minimumSamples ? "insufficient_history" : "available",
  };
}

export function groupSamples(
  samples: MetricSample[],
): Map<string, { entityName: string; samples: MetricSample[] }> {
  const groups = new Map<string, { entityName: string; samples: MetricSample[] }>();
  for (const sample of samples) {
    const group = groups.get(sample.entityId) ?? {
      entityName: sample.entityName,
      samples: [],
    };
    group.samples.push(sample);
    groups.set(sample.entityId, group);
  }
  return groups;
}

export function rankSamples(
  samples: MetricSample[],
  minimumSamples = DEFAULT_MINIMUM_RANKING_SAMPLES,
): RankedMetric[] {
  const ranked = [...groupSamples(samples).entries()]
    .map(([entityId, group]) => ({
      entityId,
      entityName: group.entityName,
      metrics: summarizeSamples(group.samples, minimumSamples),
    }))
    .filter((item) => item.metrics.delaySampleCount >= minimumSamples)
    .sort((left, right) => {
      const delayDifference =
        (right.metrics.averageDelaySeconds ?? -Infinity) -
        (left.metrics.averageDelaySeconds ?? -Infinity);
      return delayDifference || right.metrics.delaySampleCount - left.metrics.delaySampleCount;
    });

  return ranked.map((item, index) => ({ ...item, rank: index + 1 }));
}
