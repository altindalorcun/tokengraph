const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(date: string): { day: number; month: string; year: number } | null {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : { day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()]!, year: d.getUTCFullYear() };
}

/** "2026-09-18" -> "18 Sep". */
export function shortDate(date: string): string {
  const p = parts(date);
  return p ? `${p.day} ${p.month}` : date;
}

/** "2026-09-18" -> "18 Sep 2026". */
export function longDate(date: string): string {
  const p = parts(date);
  return p ? `${p.day} ${p.month} ${p.year}` : date;
}
