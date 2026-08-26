import freshnessData from './data/freshness.json';

type Dataset = {
  label: string;
  covers: string;
  effective_from: string | null;
  next_revision_expected: string | null;
  revision_cadence: string;
  source_url: string;
  watch_url: string | null;
  extractor: string | null;
  note?: string;
};

export const DATASETS = freshnessData.datasets as Record<string, Dataset>;

export type Staleness = 'current' | 'revision_due_soon' | 'overdue' | 'not_applicable';

/** Days before the expected revision at which we start warning callers. */
const WARN_WINDOW_DAYS = 45;
const DAY = 86_400_000;

/**
 * Reference data goes wrong quietly: the API keeps answering, with figures that
 * stopped being true on a date we already know. Rather than rely only on our own
 * monitoring catching a revision, every dataset states when it is next expected
 * to change and the API reports how it stands against that date.
 */
export function statusOf(d: Dataset, today: Date): { status: Staleness; days_until_revision: number | null } {
  if (!d.next_revision_expected) return { status: 'not_applicable', days_until_revision: null };
  const due = Date.parse(d.next_revision_expected + 'T00:00:00Z');
  const days = Math.floor((due - today.getTime()) / DAY);
  if (days < 0) return { status: 'overdue', days_until_revision: days };
  if (days <= WARN_WINDOW_DAYS) return { status: 'revision_due_soon', days_until_revision: days };
  return { status: 'current', days_until_revision: days };
}

export function freshnessReport(today: Date) {
  const datasets = Object.entries(DATASETS).map(([key, d]) => ({
    key,
    label: d.label,
    covers: d.covers,
    effective_from: d.effective_from,
    next_revision_expected: d.next_revision_expected,
    revision_cadence: d.revision_cadence,
    source_url: d.source_url,
    ...statusOf(d, today),
    ...(d.note ? { note: d.note } : {}),
  }));

  const overdue = datasets.filter((x) => x.status === 'overdue');
  const soon = datasets.filter((x) => x.status === 'revision_due_soon');

  return {
    checked_at: today.toISOString().slice(0, 10),
    overall: overdue.length ? 'overdue' : soon.length ? 'revision_due_soon' : 'current',
    counts: { total: datasets.length, overdue: overdue.length, due_soon: soon.length },
    datasets,
    note:
      'Japanese statutory figures change on fixed dates. This reports how each dataset stands against its next known revision, so a stale figure is visible rather than silent.',
  };
}

/** Compact marker attached to data responses. */
export function freshnessOf(key: keyof typeof DATASETS, today: Date) {
  const d = DATASETS[key];
  if (!d) return undefined;
  const { status, days_until_revision } = statusOf(d, today);
  return {
    covers: d.covers,
    next_revision_expected: d.next_revision_expected,
    status,
    ...(status === 'overdue' || status === 'revision_due_soon' ? { days_until_revision } : {}),
  };
}
