import holidayData from './data/holidays.json';

type Holiday = { date: string; name: string; name_en: string; substitute: boolean };

const HOLIDAYS = holidayData.holidays as Holiday[];
export const HOLIDAY_META = holidayData.meta;

/** ISO date -> holiday. Built once at module load, so lookups are O(1). */
const BY_DATE = new Map<string, Holiday>(HOLIDAYS.map((h) => [h.date, h]));

export const COVERAGE = {
  from: `${HOLIDAY_META.year_from}-01-01`,
  to: `${HOLIDAY_META.year_to}-12-31`,
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict ISO date parse. Rejects 2026-02-30 and other roll-overs. */
export function parseISO(s: string | null | undefined): Date | null {
  if (!s || !ISO_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export const toISO = (d: Date) => d.toISOString().slice(0, 10);

export const inCoverage = (iso: string) => iso >= COVERAGE.from && iso <= COVERAGE.to;

export const getHoliday = (iso: string) => BY_DATE.get(iso) ?? null;

/** Saturday or Sunday. */
export function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** A business day is a weekday that is not a public holiday. */
export function isBusinessDay(d: Date): boolean {
  return !isWeekend(d) && !BY_DATE.has(toISO(d));
}

export type Calendar = 'standard' | 'bank';

export const BANK_CALENDAR = {
  rule_ja: '銀行の休日 = 日曜日・土曜日・国民の祝日に関する法律に規定する休日・12月31日から翌年1月3日',
  statute: '銀行法第15条第1項 / 銀行法施行令第5条',
  statute_url: 'https://laws.e-gov.go.jp/law/357CO0000000040',
  note:
    'Article 15(1) says bank holidays are "limited to" Sunday and the days the Cabinet Order specifies, so every other day is a banking day. This is distinct from the Zengin system\'s non-operating days.',
};

/** 12/31–1/3, the year-end and new-year closure in 銀行法施行令第5条第2号. */
function isYearEndClosure(d: Date): boolean {
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return (m === 12 && day === 31) || (m === 1 && day <= 3);
}

/**
 * Banks close on Saturdays and Sundays, public holidays, and 12/31–1/3.
 * Everything else is a banking day — the statute is exhaustive.
 */
export function isBankBusinessDay(d: Date): boolean {
  return !isWeekend(d) && !BY_DATE.has(toISO(d)) && !isYearEndClosure(d);
}

export function isOpenOn(d: Date, calendar: Calendar): boolean {
  return calendar === 'bank' ? isBankBusinessDay(d) : isBusinessDay(d);
}

/** Why a given day is closed, for explainable responses. */
export function closureReasons(d: Date, calendar: Calendar): string[] {
  const reasons: string[] = [];
  const day = d.getUTCDay();
  if (day === 0) reasons.push('Sunday');
  if (day === 6) reasons.push('Saturday');
  const h = BY_DATE.get(toISO(d));
  if (h) reasons.push(`public holiday (${h.name_en})`);
  if (calendar === 'bank' && isYearEndClosure(d))
    reasons.push('year-end / new-year closure (12/31-1/3)');
  return reasons;
}

export function holidaysInYear(year: number): Holiday[] {
  const prefix = String(year).padStart(4, '0') + '-';
  return HOLIDAYS.filter((h) => h.date.startsWith(prefix));
}

export function holidaysBetween(from: string, to: string): Holiday[] {
  return HOLIDAYS.filter((h) => h.date >= from && h.date <= to);
}

const DAY = 86_400_000;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/**
 * Count business days in [start, end] inclusive.
 * Callers must keep the range inside COVERAGE — beyond it, holidays are unknown
 * and the count would silently overstate the number of business days.
 */
export function countBusinessDays(start: Date, end: Date, calendar: Calendar = 'standard') {
  let business = 0;
  let weekend = 0;
  let holiday = 0;
  let yearEnd = 0;
  let total = 0;
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    total++;
    const w = isWeekend(d);
    const h = BY_DATE.has(toISO(d));
    if (w) weekend++;
    if (h) holiday++;
    if (calendar === 'bank' && !w && !h && isYearEndClosure(d)) yearEnd++;
    if (isOpenOn(d, calendar)) business++;
  }
  return calendar === 'bank'
    ? { total, business, weekend, holiday, year_end_closure: yearEnd }
    : { total, business, weekend, holiday };
}

/** Nth business day strictly after `from` (n >= 1), or before it when n <= -1. */
export function shiftBusinessDays(from: Date, n: number, calendar: Calendar = 'standard'): Date | null {
  if (n === 0) return from;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let d = from;
  // Coverage is ~73 years; this bound is a safety net, not an expected path.
  for (let guard = 0; guard < 40_000 && remaining > 0; guard++) {
    d = addDays(d, step);
    if (!inCoverage(toISO(d))) return null;
    if (isOpenOn(d, calendar)) remaining--;
  }
  return remaining === 0 ? d : null;
}
