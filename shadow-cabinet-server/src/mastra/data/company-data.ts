export interface Segment {
  name: string;
  revenue: number;
  grossMarginPct: number;
}

export interface Quarter {
  period: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  salesMarketing: number;
  rnd: number;
  ga: number;
  operatingIncome: number;
  operatingMarginPct: number;
  cash: number;
  headcount: number;
  newCustomers: number;
  churnPct: number;
  cac: number;
  ltv: number;
  segments: Segment[];
}

export interface CompanyData {
  company: string;
  currency: string;
  unit: string;
  quarters: Quarter[];
}

export const METRIC_NAMES = [
  "revenue",
  "cogs",
  "grossProfit",
  "grossMarginPct",
  "salesMarketing",
  "rnd",
  "ga",
  "operatingIncome",
  "operatingMarginPct",
  "cash",
  "headcount",
  "newCustomers",
  "churnPct",
  "cac",
  "ltv",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export function listPeriods(data: CompanyData): string[] {
  return data.quarters.map((quarter) => quarter.period);
}

function requireQuarter(data: CompanyData, period: string): Quarter {
  const quarter = data.quarters.find((entry) => entry.period === period);
  if (!quarter) {
    throw new Error(
      `Unknown period "${period}". Valid periods: ${listPeriods(data).join(", ")}.`,
    );
  }
  return quarter;
}

function requireMetric(metric: string): MetricName {
  if (!METRIC_NAMES.includes(metric as MetricName)) {
    throw new Error(
      `Unknown metric "${metric}". Valid metrics: ${METRIC_NAMES.join(", ")}.`,
    );
  }
  return metric as MetricName;
}

export function getMetric(
  data: CompanyData,
  metric: MetricName,
  period: string,
): { metric: MetricName; period: string; value: number } {
  const name = requireMetric(metric);
  const quarter = requireQuarter(data, period);

  return { metric: name, period, value: quarter[name] };
}

export function compareMetric(
  data: CompanyData,
  metric: MetricName,
  fromPeriod: string,
  toPeriod: string,
): {
  metric: MetricName;
  from: { period: string; value: number };
  to: { period: string; value: number };
  delta: number;
  deltaPct: number;
} {
  const from = getMetric(data, metric, fromPeriod);
  const to = getMetric(data, metric, toPeriod);

  const delta = to.value - from.value;
  // Guard against a zero baseline so the tool never returns Infinity or NaN.
  const deltaPct = from.value === 0 ? 0 : (delta / from.value) * 100;

  return {
    metric: from.metric,
    from: { period: from.period, value: from.value },
    to: { period: to.period, value: to.value },
    delta,
    deltaPct,
  };
}

export function getSegmentMix(
  data: CompanyData,
  period: string,
): {
  period: string;
  totalRevenue: number;
  segments: Array<{
    name: string;
    revenue: number;
    revenueSharePct: number;
    grossMarginPct: number;
  }>;
} {
  const quarter = requireQuarter(data, period);
  const totalRevenue = quarter.revenue;

  return {
    period,
    totalRevenue,
    segments: quarter.segments.map((segment) => ({
      name: segment.name,
      revenue: segment.revenue,
      revenueSharePct:
        totalRevenue === 0 ? 0 : (segment.revenue / totalRevenue) * 100,
      grossMarginPct: segment.grossMarginPct,
    })),
  };
}
