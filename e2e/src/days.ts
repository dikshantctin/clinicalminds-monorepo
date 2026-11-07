/**
 * Clinic-local dates for booking specs. A clinic is closed on Sunday unless its admin opens it
 * (clinic hours default: Mon–Sat 10:00–18:00), so a spec that needs public slots uses openDay.
 */
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
const isoWeekday = (day: string) => ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = Monday … 7 = Sunday

/** The `n`-th clinic-local day after today that is not a Sunday (n ≥ 1). It assumes the clinic keeps the
 * default open days (only Sunday closed) and lists no holidays: true for the demo clinic, which no spec
 * changes (specs that change hours onboard their own clinic). Different n → different days, so
 * specs that book on their own day (day 2, day 3, …) still never share one. */
export function openDay(n: number, tz = 'Asia/Kolkata'): string {
  let day = ymd(new Date(), tz);
  for (let open = 0; open < n; ) {
    day = ymd(new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000), 'UTC');
    if (isoWeekday(day) !== 7) open += 1;
  }
  return day;
}

/** The first clinic-local date at least `daysAhead` from today that falls on ISO weekday `weekday` (1 = Mon … 7 = Sun). */
export function nextWeekday(weekday: number, daysAhead: number, tz = 'Asia/Kolkata'): string {
  let day = ymd(new Date(Date.now() + daysAhead * 86_400_000), tz);
  while (isoWeekday(day) !== weekday) day = ymd(new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000), 'UTC');
  return day;
}

/** The calendar date `n` days after `day` ("2026-11-10", 2 → "2026-11-12"). */
export const addDays = (day: string, n: number): string => ymd(new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 86_400_000), 'UTC');

export { isoWeekday };
