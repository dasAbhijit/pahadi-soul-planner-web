import { trekEndDate, type Trek } from './models';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Nov 2026" in the local time zone. */
export function fmtDate(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
}

/** "3 Nov 2026, 6:30 pm" */
export function fmtDateTime(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  const h = x.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${fmtDate(x)}, ${h12}:${String(x.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** Groups digits the Indian way: last three, then pairs (1,48,500). */
export function grouped(n: number): string {
  const s = String(Math.abs(n));
  let out = s;
  if (s.length > 3) {
    const head = s.slice(0, -3);
    const pairs: string[] = [];
    for (let i = head.length; i > 0; i -= 2) pairs.unshift(head.slice(Math.max(0, i - 2), i));
    out = pairs.join(',') + ',' + s.slice(-3);
  }
  return n < 0 ? '-' + out : out;
}

export const rupees = (n: number) => '₹' + grouped(n);
export const signedRupees = (n: number) => (n < 0 ? '−' + rupees(-n) : rupees(n));

/** "3 Nov 2026 to 6 Nov 2026 · 4 days · Moderate" */
export function trekSummary(t: Trek): string {
  const parts: string[] = [];
  if (t.startDate) parts.push(`${fmtDate(t.startDate)} to ${fmtDate(trekEndDate(t) ?? new Date(t.startDate))}`);
  parts.push(`${t.durationDays} days`);
  parts.push(t.difficulty);
  return parts.join(' · ');
}
