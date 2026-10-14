/** Local-time helpers. Date keys are local calendar days "YYYY-MM-DD". */

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function epochToDateKey(epochS: number): string {
  return toDateKey(new Date(epochS * 1000));
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Local midnight (epoch seconds) of a date key. */
export function dateKeyStartEpoch(key: string): number {
  return Math.floor(parseDateKey(key).getTime() / 1000);
}

export function addDays(key: string, n: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}

export function todayKey(now = new Date()): string {
  return toDateKey(now);
}

/** Inclusive list of date keys from a to b. */
export function dateRange(a: string, b: string): string[] {
  const out: string[] = [];
  let k = a;
  let guard = 0;
  while (k <= b && guard++ < 5000) {
    out.push(k);
    k = addDays(k, 1);
  }
  return out;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDateKey(b).getTime() - parseDateKey(a).getTime()) / 86400000);
}

/** Monday-based week start key. */
export function weekStartKey(key: string): string {
  const d = parseDateKey(key);
  const dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow);
  return toDateKey(d);
}

export function monthKey(key: string): string {
  return key.slice(0, 7);
}

/** Minutes after local midnight for an epoch. */
export function minuteOfDay(epochS: number): number {
  const d = new Date(epochS * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

export function formatMinuteOfDay(min: number, fmt: '12h' | '24h' = '12h'): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  if (fmt === '24h') return `${pad(h)}:${pad(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
}

export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function shortDate(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function longDate(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
