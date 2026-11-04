/** Ids and dates. Ids are upper-case UUID text and dates are ISO 8601 text to the second, like the iPhone and Android apps. */

export type Id = string;
export type Instant = string; // 2026-11-03T18:30:00Z

export function newId(): Id {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().toUpperCase();
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isId(v: unknown): v is Id {
  return typeof v === 'string' && UUID.test(v);
}

/** Writes a date as 2026-11-03T18:30:00Z (whole seconds). */
export function toInstant(d: Date | number): Instant {
  const ms = typeof d === 'number' ? d : d.getTime();
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Now, cut to whole seconds, so a date reads back from storage or the sheet exactly as it was made. */
export function nowSecond(): Instant {
  return toInstant(Date.now());
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Reads a date written by any of the three apps. Returns null if it is not a date. */
export function parseInstant(v: unknown): Instant | null {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : toInstant(ms);
}

export function ms(i: Instant): number {
  return Date.parse(i);
}

/** Start of the local day that `i` falls on. */
export function startOfDay(i: Instant | Date | number): Date {
  const d = typeof i === 'string' ? new Date(i) : new Date(i);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
}

/** yyyy-MM-dd in the local time zone (what a date field holds). */
export function dayKey(i: Instant | Date): string {
  const d = typeof i === 'string' ? new Date(i) : i;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** yyyy-MM-dd HH:mm in the local time zone. */
export function stampKey(i: Instant): string {
  const d = new Date(i);
  return `${dayKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local midnight of a yyyy-MM-dd date field, as an Instant. */
export function fromDayKey(key: string): Instant | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return undefined;
  return toInstant(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
