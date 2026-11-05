import {
  DIFFICULTIES, ENTRY_KINDS, PAYMENT_MODES, PAYMENT_STATUSES, RATE_UNITS, SERVICE_TYPES,
  type Booking, type GuidanceRule, type LedgerEntry, type SyncFields, type Trek, type TripAgreement, type TripShare, type Vendor,
} from './models';
import { isId, nowSecond, parseInstant, toInstant, type Id, type Instant } from './ids';

/**
 * Reads a record from JSON the way the iPhone and Android apps do: a missing optional field takes its default,
 * a field of the wrong kind makes the whole record unreadable (null). Dates are ISO 8601; ids are UUID text.
 * Output is always a clean object with no nulls, so two copies of the same record compare equal.
 */
class Reader {
  ok = true;
  constructor(private o: Record<string, unknown>) {}

  has(k: string): boolean { return this.o[k] !== undefined && this.o[k] !== null; }
  private get(k: string): unknown {
    const v = this.o[k];
    return v === null ? undefined : v;
  }
  private bad(): undefined { this.ok = false; return undefined; }

  id(k: string): Id { const v = this.get(k); return isId(v) ? v.toUpperCase() : (this.bad() as unknown as Id); }
  optId(k: string): Id | undefined { const v = this.get(k); if (v === undefined) return undefined; return isId(v) ? v.toUpperCase() : this.bad(); }
  str(k: string, def?: string): string {
    const v = this.get(k);
    if (v === undefined && def !== undefined) return def;
    return typeof v === 'string' ? v : (this.bad() as unknown as string);
  }
  optStr(k: string): string | undefined { const v = this.get(k); if (v === undefined) return undefined; return typeof v === 'string' ? v : this.bad(); }
  int(k: string, def?: number): number {
    const v = this.get(k);
    if (v === undefined && def !== undefined) return def;
    return Number.isInteger(v) ? (v as number) : (this.bad() as unknown as number);
  }
  optInt(k: string): number | undefined { const v = this.get(k); if (v === undefined) return undefined; return Number.isInteger(v) ? (v as number) : this.bad(); }
  date(k: string): Instant { const v = parseInstant(this.get(k)); return v ?? (this.bad() as unknown as Instant); }
  dateOr(k: string, def: Instant): Instant { const v = this.get(k); if (v === undefined) return def; return parseInstant(v) ?? (this.bad() as unknown as Instant); }
  optDate(k: string): Instant | undefined { const v = this.get(k); if (v === undefined) return undefined; return parseInstant(v) ?? this.bad(); }
  oneOf<T extends string>(k: string, all: readonly T[], def?: T): T {
    const v = this.get(k);
    if (v === undefined && def !== undefined) return def;
    return typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : (this.bad() as unknown as T);
  }
  list<T>(k: string, each: (o: Record<string, unknown>) => T | null): T[] {
    const v = this.get(k);
    if (v === undefined) return [];
    if (!Array.isArray(v)) { this.bad(); return []; }
    const out: T[] = [];
    for (const item of v) {
      const x = item && typeof item === 'object' && !Array.isArray(item) ? each(item as Record<string, unknown>) : null;
      if (x === null) { this.bad(); return []; }
      out.push(x);
    }
    return out;
  }
  strings(k: string): string[] {
    const v = this.get(k);
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) { this.bad(); return []; }
    return v as string[];
  }
}

/** Drops undefined values so the record reads exactly like its saved copy. */
function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stamps(r: Reader) {
  return {
    updatedAt: r.optDate('updatedAt'), deletedAt: r.optDate('deletedAt'),
    createdBy: r.optId('createdBy'), updatedBy: r.optId('updatedBy'),
  };
}

export function parseTrek(o: unknown): Trek | null {
  if (!isObj(o)) return null;
  const r = new Reader(o);
  const t = clean<Trek>({
    id: r.id('id'), name: r.str('name', ''), region: r.str('region', ''), durationDays: r.int('durationDays', 3),
    difficulty: r.oneOf('difficulty', DIFFICULTIES, 'Moderate'), maxAltitudeFt: r.optInt('maxAltitudeFt'),
    pricePerPerson: r.optInt('pricePerPerson'), startDate: r.optDate('startDate'), seatsLeft: r.optInt('seatsLeft'),
    highlights: r.str('highlights', ''), notes: r.str('notes', ''), seatCapacity: r.optInt('seatCapacity'), ...stamps(r),
  });
  return r.ok ? t : null;
}

export function parseBooking(o: unknown): Booking | null {
  if (!isObj(o)) return null;
  const r = new Reader(o);
  // travellers and phone have no default in the other apps, so a row without them is unreadable there too.
  if (!r.has('travellers') || !r.has('phone')) return null;
  const b = clean<Booking>({
    id: r.id('id'), trekID: r.id('trekID'), travellers: r.strings('travellers'), phone: r.str('phone'),
    payment: r.oneOf('payment', PAYMENT_STATUSES, 'Pending'), amountReceived: r.optInt('amountReceived'),
    createdAt: r.dateOr('createdAt', nowSecond()), cancelledAt: r.optDate('cancelledAt'), ...stamps(r),
  });
  return r.ok ? b : null;
}

function parseShare(o: Record<string, unknown>): TripShare | null {
  const r = new Reader(o);
  const s = { trekID: r.id('trekID'), trekName: r.str('trekName'), amount: r.int('amount') };
  return r.ok ? s : null;
}

export function parseEntry(o: unknown): LedgerEntry | null {
  if (!isObj(o)) return null;
  const r = new Reader(o);
  const e = clean<LedgerEntry>({
    id: r.id('id'), date: r.date('date'), kind: r.oneOf('kind', ENTRY_KINDS), amount: r.int('amount'),
    mode: r.oneOf('mode', PAYMENT_MODES, 'UPI'), party: r.str('party', ''), note: r.str('note', ''),
    bookingID: r.optId('bookingID'), customerName: r.optStr('customerName'), shares: r.list('shares', parseShare),
    vendorID: r.optId('vendorID'), vendorName: r.optStr('vendorName'), createdAt: r.dateOr('createdAt', nowSecond()), ...stamps(r),
  });
  return r.ok ? e : null;
}

function parseAgreement(o: Record<string, unknown>): TripAgreement | null {
  const r = new Reader(o);
  const a = { trekID: r.id('trekID'), trekName: r.str('trekName'), amount: r.int('amount') };
  return r.ok ? a : null;
}

export function parseVendor(o: unknown): Vendor | null {
  if (!isObj(o)) return null;
  const r = new Reader(o);
  const v = clean<Vendor>({
    id: r.id('id'), name: r.str('name'), service: r.oneOf('service', SERVICE_TYPES, 'Other'),
    contactName: r.str('contactName', ''), phone: r.str('phone', ''), rate: r.optInt('rate'),
    rateUnit: r.oneOf('rateUnit', RATE_UNITS, 'per trip'), tags: r.strings('tags'), notes: r.str('notes', ''),
    agreements: r.list('agreements', parseAgreement), createdAt: r.dateOr('createdAt', nowSecond()), ...stamps(r),
  });
  return r.ok ? v : null;
}

export function parseRule(o: unknown): GuidanceRule | null {
  if (!isObj(o)) return null;
  const r = new Reader(o);
  const g = clean<GuidanceRule>({ id: r.id('id'), text: r.str('text'), createdAt: r.dateOr('createdAt', nowSecond()), ...stamps(r) });
  return r.ok ? g : null;
}

// ------------------------------------------------------------------ JSON text

const DATE_KEYS = new Set(['date', 'createdAt', 'updatedAt', 'deletedAt', 'startDate', 'cancelledAt']);
const FRACTION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+(Z|[+-]\d{2}:\d{2})$/;

/**
 * JSON with sorted keys and no undefined values, so equal records give equal text. Date fields are cut to whole
 * seconds, as they are when saved, so a record made a moment ago in memory equals its saved copy.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (k, v) => {
    if (typeof v === 'string' && DATE_KEYS.has(k)) {
      const m = FRACTION.exec(v);
      if (m) return toInstant(Date.parse(v));
      return v;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) if (src[k] !== undefined) out[k] = src[k];
      return out;
    }
    return v;
  });
}

/** One record as a line of JSON, the way the sheet's "Record (JSON)" column holds it. */
export const encodeRecord = (r: unknown): string => canonical(r);

/** Two copies of a record are the same when they read the same once saved. */
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

export function decodeLine<T>(parse: (o: unknown) => T | null, line: string): T | null {
  try { return parse(JSON.parse(line)); } catch { return null; }
}
