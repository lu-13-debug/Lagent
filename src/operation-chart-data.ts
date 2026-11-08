export type Granularity = 'day' | 'week' | 'month';
export type CumulativeMetric = 'newUsers' | 'revenue';

export interface ChartDailyRow {
  date: string;
  dau: number | null;
  newUsers: number | null;
  revenue: number | null;
  payers: number | null;
}

export interface GroupedDaily {
  key: string;
  label: string;
  days: number;
  values: { dau: number | null; newUsers: number | null; revenue: number | null; payers: number | null };
  coverage: { dau: number; newUsers: number; revenue: number; payers: number };
  payerRate: number | null;
}

export interface PaymentPoint {
  label: string;
  days: number;
  payers: number | null;
  rate: number | null;
}

export interface CumulativePoint {
  label: string;
  value: number;
  coverage: number;
}

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const numeric = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

function groupKey(date: string, granularity: Granularity) {
  if (granularity === 'day') return date;
  if (granularity === 'month') return date.slice(0, 7);
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function groupDaily(daily: ChartDailyRow[], granularity: Granularity): GroupedDaily[] {
  const groups = new Map<string, ChartDailyRow[]>();
  for (const row of daily) {
    const key = groupKey(row.date, granularity);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const values = { dau: 0, newUsers: 0, revenue: 0, payers: 0 };
    const coverage = { dau: 0, newUsers: 0, revenue: 0, payers: 0 };
    let ratePayers = 0; let rateDau = 0;
    for (const row of rows) {
      if (numeric(row.dau)) { values.dau += row.dau; coverage.dau++; }
      if (numeric(row.newUsers)) { values.newUsers += row.newUsers; coverage.newUsers++; }
      if (numeric(row.revenue)) { values.revenue += row.revenue; coverage.revenue++; }
      if (numeric(row.payers)) { values.payers += row.payers; coverage.payers++; }
      if (numeric(row.payers) && numeric(row.dau) && row.dau > 0) { ratePayers += row.payers; rateDau += row.dau; }
    }
    return {
      key,
      label: rows[0].date,
      days: rows.length,
      values: {
        dau: coverage.dau ? values.dau : null,
        newUsers: coverage.newUsers ? values.newUsers : null,
        revenue: coverage.revenue ? round(values.revenue) : null,
        payers: coverage.payers ? values.payers : null,
      },
      coverage,
      payerRate: rateDau ? round(ratePayers * 100 / rateDau) : null,
    };
  });
}

export function paymentSeries(daily: ChartDailyRow[], granularity: Granularity): PaymentPoint[] {
  return groupDaily(daily, granularity).map(group => ({ label: group.label, days: group.days, payers: group.values.payers, rate: group.payerRate }));
}

export function cumulativeSeries(daily: ChartDailyRow[], granularity: Granularity, metric: CumulativeMetric): CumulativePoint[] {
  let running = 0;
  return groupDaily(daily, granularity).map(group => {
    const value = group.values[metric];
    if (value != null) running = round(running + value);
    return { label: group.label, value: running, coverage: group.coverage[metric] };
  });
}
