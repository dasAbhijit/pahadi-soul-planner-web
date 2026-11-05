import { type Id, type Instant, newId, nowSecond, startOfDay, addDays, ms } from './ids';

/** Fields every synced record carries. A deleted record is kept with `deletedAt` set (a tombstone). */
export interface SyncFields {
  id: Id;
  updatedAt?: Instant;
  deletedAt?: Instant;
  /** The person who made the record and the person who last changed it. Records from before sign-in have neither. */
  createdBy?: Id;
  updatedBy?: Id;
}

// ---------------------------------------------------------------- Treks

export const DIFFICULTIES = ['Easy', 'Moderate', 'Hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export type TrekTiming = 'upcoming' | 'undated' | 'past';

export interface Trek extends SyncFields {
  name: string;
  region: string;
  durationDays: number;
  difficulty: Difficulty;
  maxAltitudeFt?: number;
  pricePerPerson?: number; // INR
  startDate?: Instant;
  seatsLeft?: number;
  highlights: string;
  notes: string;
  /** Total seats for a dated trek. Seats left is this minus the seats of live bookings. */
  seatCapacity?: number;
}

export function makeTrek(p: Partial<Trek> = {}): Trek {
  return {
    id: newId(), name: '', region: '', durationDays: 3, difficulty: 'Moderate', highlights: '', notes: '', ...p,
  };
}

export function trekTiming(t: Trek, now: Date = new Date()): TrekTiming {
  if (!t.startDate) return 'undated';
  return ms(t.startDate) >= startOfDay(now).getTime() ? 'upcoming' : 'past';
}

/** A copy for a repeat run: new id and date, same price, duration and notes. Seats are cleared. */
export function duplicatedTrek(t: Trek, startingOn: Instant | undefined): Trek {
  const c: Trek = { ...t, id: newId(), startDate: startingOn };
  delete c.seatsLeft; delete c.seatCapacity; delete c.updatedAt; delete c.deletedAt; delete c.createdBy; delete c.updatedBy;
  return c;
}

export function trekEndDate(t: Trek): Date | undefined {
  if (!t.startDate) return undefined;
  return addDays(new Date(t.startDate), Math.max(t.durationDays, 1) - 1);
}

// ------------------------------------------------------------- Bookings

export const PAYMENT_STATUSES = ['Pending', 'Part paid', 'Paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Booking extends SyncFields {
  trekID: Id;
  travellers: string[]; // first name is the booking contact
  phone: string;
  payment: PaymentStatus;
  amountReceived?: number; // INR
  createdAt: Instant;
  cancelledAt?: Instant; // cancelled bookings are kept so refunds can still name the traveller
}

export function makeBooking(p: Pick<Booking, 'trekID' | 'travellers' | 'phone'> & Partial<Booking>): Booking {
  return { id: newId(), payment: 'Pending', createdAt: nowSecond(), ...p };
}

export const isCancelled = (b: Booking) => b.cancelledAt !== undefined;
export const partySize = (b: Booking) => b.travellers.length;

// --------------------------------------------------------------- Ledger

export const ENTRY_KINDS = ['Money in', 'Money out'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const PAYMENT_MODES = ['Cash', 'UPI', 'Bank transfer', 'Card', 'Other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** The part of an entry that belongs to one trip. The trip name is copied in so the record still reads after a trek is deleted. */
export interface TripShare { trekID: Id; trekName: string; amount: number }

export interface LedgerEntry extends SyncFields {
  date: Instant;
  kind: EntryKind;
  amount: number; // INR, always positive; `kind` gives the direction
  mode: PaymentMode;
  party: string;
  note: string;
  bookingID?: Id; // the traveller, via their booking
  customerName?: string; // copied from the booking
  shares: TripShare[];
  vendorID?: Id; // set on payouts to a vendor
  vendorName?: string; // copied from the vendor
  createdAt: Instant;
}

export function makeEntry(p: Pick<LedgerEntry, 'date' | 'kind' | 'amount'> & Partial<LedgerEntry>): LedgerEntry {
  return { id: newId(), mode: 'UPI', party: '', note: '', shares: [], createdAt: nowSecond(), ...p };
}

export const isGeneral = (e: LedgerEntry) => e.shares.length === 0;
export const signedAmount = (e: LedgerEntry) => (e.kind === 'Money in' ? e.amount : -e.amount);

export type LedgerScope = { type: 'all' } | { type: 'general' } | { type: 'trek'; id: Id };
export const SCOPE_ALL: LedgerScope = { type: 'all' };

/** The amount that counts for a view: the trip's share when looking at one trip. */
export function amountIn(e: LedgerEntry, scope: LedgerScope): number {
  return scope.type === 'trek' ? (e.shares.find((s) => s.trekID === scope.id)?.amount ?? 0) : e.amount;
}

export interface LedgerFilter {
  scope: LedgerScope;
  kind?: EntryKind;
  customer: string;
  vendorID?: Id;
  from?: Instant;
  to?: Instant;
}

export interface PaymentSummary { due?: number; received: number; status: PaymentStatus; balance?: number }

export interface TripLine { trekID: Id; trekName: string; agreed: number; paid: number; owed: number }

/** What one vendor has been paid and is still owed, built from the ledger. */
export interface VendorStatement {
  totalPaid: number;
  totalAgreed: number;
  trips: TripLine[]; // trips with an agreed amount or a payment
  unassignedPaid: number; // paid with no trip (only old entries)
  owed: number;
}

// -------------------------------------------------------------- Vendors

export const SERVICE_TYPES = ['Guide', 'Porter', 'Stay', 'Transport', 'Food', 'Permits', 'Equipment', 'Other'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const RATE_UNITS = ['per day', 'per person', 'per night', 'per trip', 'flat fee'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

/** What a vendor has been promised for one trip. Money still owed is this minus what the ledger shows as paid. */
export interface TripAgreement { trekID: Id; trekName: string; amount: number }

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 24;

export interface Vendor extends SyncFields {
  name: string;
  service: ServiceType;
  contactName: string;
  phone: string;
  rate?: number; // INR; undefined when not fixed
  rateUnit: RateUnit;
  tags: string[]; // places, seasons, anything useful for matching
  notes: string;
  agreements: TripAgreement[];
  createdAt: Instant;
}

export function makeVendor(p: Pick<Vendor, 'name'> & Partial<Vendor>): Vendor {
  return {
    id: newId(), service: 'Other', contactName: '', phone: '', rateUnit: 'per trip', tags: [], notes: '',
    agreements: [], createdAt: nowSecond(), ...p,
  };
}

export const vendorAgreed = (v: Vendor, trekID: Id) => v.agreements.find((a) => a.trekID === trekID)?.amount ?? 0;
export const vendorTotalAgreed = (v: Vendor) => v.agreements.reduce((s, a) => s + a.amount, 0);
export const vendorRateText = (v: Vendor) => (v.rate !== undefined ? `Rs ${v.rate} ${v.rateUnit}` : undefined);

/** "Darjeeling, winter ,, Darjeeling" becomes ["darjeeling", "winter"]. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of text.split(/[,\n]/)) {
    const t = piece.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

// ------------------------------------------------------------- Guidance

export interface GuidanceRule extends SyncFields {
  text: string;
  createdAt: Instant;
}

export function makeRule(text: string, createdAt: Instant = nowSecond()): GuidanceRule {
  return { id: newId(), text, createdAt };
}
