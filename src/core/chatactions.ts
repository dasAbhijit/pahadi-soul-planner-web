import { AppError } from './errors';
import { fmtDate, rupees } from './fmt';
import { dayKey, startOfDay, toInstant, type Id, type Instant } from './ids';
import {
  DIFFICULTIES, PAYMENT_MODES, RATE_UNITS, SERVICE_TYPES, isCancelled, makeEntry, makeTrek, makeVendor, partySize, trekEndDate, trekTiming, vendorAgreed,
  type Booking, type Difficulty, type LedgerEntry, type PaymentMode, type RateUnit, type ServiceType, type Trek, type Vendor,
} from './models';
import { can, type Capability, type Role } from './roles';
import { LedgerStore, MAX_AMOUNT, MAX_PARTY, type BookingStore, type TrekStore, type VendorStore } from './stores';

/**
 * Chat actions: the assistant may DRAFT a booking, a payment, a trek or a vendor from what staff type. A draft is only a card.
 * Nothing is written until a person taps Approve (or saves it from the normal form), and Approve runs the same
 * code as the forms. The assistant never sees or names record ids: it names a trek or vendor by a short reference (T3, V2),
 * and the app finds the traveller among the bookings on the phone.
 */

export const TOOL_BOOKING = 'draft_booking';
export const TOOL_PAYMENT_IN = 'draft_payment_received';
export const TOOL_PAYMENT_OUT = 'draft_payment_out';
export const TOOL_TREK = 'draft_trek';
export const TOOL_VENDOR = 'draft_vendor';
export const DRAFT_TOOLS: readonly string[] = [TOOL_BOOKING, TOOL_PAYMENT_IN, TOOL_PAYMENT_OUT, TOOL_TREK, TOOL_VENDOR];

/** At most this many cards from one reply. */
export const MAX_DRAFTS_PER_REPLY = 5;
/** The prompt lists this many vendors, so only these have a reference. */
export const MAX_VENDOR_REFS = 40;

export type DraftKind = 'booking' | 'paymentIn' | 'paymentOut' | 'trek' | 'vendor';
export type DraftState = 'pending' | 'applied' | 'saved' | 'denied' | 'replaced';

export interface BookingDraftData {
  kind: 'booking';
  trekID?: Id;
  travellers: string[];
  phone: string;
  amountReceived?: number;
  mode?: PaymentMode;
}

export interface PaymentInDraftData {
  kind: 'paymentIn';
  trekID?: Id;
  amount?: number;
  mode?: PaymentMode;
  date: Instant;
  note: string;
  bookingID?: Id;
  /** What staff called the traveller. The phone matches it against the bookings on the chosen trek. */
  travellerQuery: string;
}

/** Money out goes to a vendor, or back to a traveller as a refund. Exactly one of the two. */
export interface PaymentOutDraftData {
  kind: 'paymentOut';
  trekID?: Id;
  amount?: number;
  mode?: PaymentMode;
  date: Instant;
  note: string;
  vendorID?: Id;
  vendorQuery: string;
  bookingID?: Id;
  travellerQuery: string;
}

export interface TrekDraftData {
  kind: 'trek';
  name: string;
  region: string;
  durationDays?: number;
  difficulty?: Difficulty;
  startDate?: Instant;
  pricePerPerson?: number;
  seats?: number;
  maxAltitudeFt?: number;
  highlights: string;
  notes: string;
}

export interface VendorDraftData {
  kind: 'vendor';
  name: string;
  service?: ServiceType;
  contactName: string;
  phone: string;
  rate?: number;
  rateUnit?: RateUnit;
  tags: string[];
  notes: string;
  /** One agreed amount for one trip, as the form's "Agreed amount per trip". */
  agreedTrekID?: Id;
  agreedAmount?: number;
}

export type DraftData = BookingDraftData | PaymentInDraftData | PaymentOutDraftData | TrekDraftData | VendorDraftData;

export interface Draft {
  /** Short and unique within the chat (D1, D2 ...). The assistant is told these so it can replace a draft. */
  id: string;
  data: DraftData;
  state: DraftState;
  /** Why the last Approve failed. The card stays open. */
  error?: string;
  /** The app's own words for what was saved. */
  result?: string;
  recordIDs?: Id[];
}

export interface FunctionDecl { name: string; description: string; parameters: Record<string, unknown> }

const CAPABILITY: Record<DraftKind, Capability | null> = {
  booking: null, paymentIn: null, paymentOut: 'seeMoneyOut', trek: 'editTreks', vendor: 'editVendors',
};

/**
 * Which drafts a role may be offered. Staff get a booking and a payment received. Managers and Owners also get money out,
 * a trek and a vendor, the same things they can do in the forms. Nobody signed in gets nothing.
 */
export function draftsAllowed(role: Role | undefined): DraftKind[] {
  if (role === undefined) return [];
  return (Object.keys(CAPABILITY) as DraftKind[]).filter((k) => CAPABILITY[k] === null || can(role, CAPABILITY[k]!));
}

/** What the notice and Settings say the assistant can prepare for this role. */
export function draftsSummary(role: Role | undefined): string {
  return draftsAllowed(role).includes('trek') ? 'trips, vendors, bookings and payments' : 'bookings and payments received';
}

const MODE_ENUM = [...PAYMENT_MODES];
const REPLACES = { type: 'STRING', description: 'The id (D1, D2 ...) of an earlier draft this one replaces, when staff change that draft.' };

export function toolDeclarations(role: Role | undefined): FunctionDecl[] {
  const out: FunctionDecl[] = [];
  const allowed = draftsAllowed(role);
  if (allowed.includes('booking')) {
    out.push({
      name: TOOL_BOOKING,
      description: 'Prepare a DRAFT booking for staff to check. Nothing is saved until staff tap Approve. Call it only when staff clearly ask to add a booking.',
      parameters: {
        type: 'OBJECT',
        properties: {
          trek_ref: { type: 'STRING', description: 'The reference of the trek in the catalogue, for example T3.' },
          travellers: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Full names of every traveller. The first is the booking contact.' },
          phone: { type: 'STRING', description: 'The contact number staff gave. Do not invent one.' },
          amount_received: { type: 'NUMBER', description: 'Rupees received now, only if staff said so.' },
          payment_mode: { type: 'STRING', enum: MODE_ENUM, description: 'How the money was paid, only if staff said.' },
          replaces: REPLACES,
        },
        required: ['trek_ref', 'travellers'],
      },
    });
  }
  if (allowed.includes('paymentIn')) {
    out.push({
      name: TOOL_PAYMENT_IN,
      description: 'Prepare a DRAFT for a payment received from a traveller. Nothing is saved until staff tap Approve. Call it only when staff clearly report a payment received.',
      parameters: {
        type: 'OBJECT',
        properties: {
          trek_ref: { type: 'STRING', description: 'The reference of the trek in the catalogue, for example T3.' },
          traveller_name: { type: 'STRING', description: 'The name of the traveller who paid, as staff said it.' },
          amount: { type: 'NUMBER', description: 'Rupees received. Only what staff said, or a sum staff asked for.' },
          payment_mode: { type: 'STRING', enum: MODE_ENUM, description: 'How it was paid, only if staff said.' },
          date: { type: 'STRING', description: 'The day it was received, as YYYY-MM-DD. Omit for today.' },
          note: { type: 'STRING', description: 'A short note, only if staff gave one.' },
          replaces: REPLACES,
        },
        required: ['trek_ref', 'traveller_name', 'amount'],
      },
    });
  }
  if (allowed.includes('paymentOut')) {
    out.push({
      name: TOOL_PAYMENT_OUT,
      description: 'Prepare a DRAFT for money paid out: to a vendor, or a refund to a traveller. Nothing is saved until staff tap Approve. Call it only when staff clearly report a payment made.',
      parameters: {
        type: 'OBJECT',
        properties: {
          trek_ref: { type: 'STRING', description: 'The reference of the trip this cost belongs to, for example T3. One trip only.' },
          vendor_ref: { type: 'STRING', description: 'The reference of the vendor in the vendor list, for example V2. Leave out for a refund.' },
          vendor_name: { type: 'STRING', description: 'The vendor as staff said the name, if the reference is not known.' },
          traveller_name: { type: 'STRING', description: 'For a refund only: the traveller being paid back, as staff said it. Never together with a vendor.' },
          amount: { type: 'NUMBER', description: 'Rupees paid. Only what staff said.' },
          payment_mode: { type: 'STRING', enum: MODE_ENUM, description: 'How it was paid, only if staff said.' },
          date: { type: 'STRING', description: 'The day it was paid, as YYYY-MM-DD. Omit for today.' },
          note: { type: 'STRING', description: 'A short note, only if staff gave one.' },
          replaces: REPLACES,
        },
        required: ['trek_ref', 'amount'],
      },
    });
  }
  if (allowed.includes('trek')) {
    out.push({
      name: TOOL_TREK,
      description: 'Prepare a DRAFT new trek for the catalogue. Nothing is saved until staff tap Approve. Call it only when staff clearly ask to add a trek.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'The trek name.' },
          duration_days: { type: 'NUMBER', description: 'How many days. Required: ask if not given.' },
          start_date: { type: 'STRING', description: 'The first day as YYYY-MM-DD. Leave out for a trek available on request.' },
          difficulty: { type: 'STRING', enum: [...DIFFICULTIES], description: 'Easy, Moderate or Hard, only if staff said.' },
          region: { type: 'STRING', description: 'Where it is, only if staff said.' },
          price_per_person: { type: 'NUMBER', description: 'Rupees per person, only if staff said.' },
          seats: { type: 'NUMBER', description: 'Total seats on sale for a dated trek, only if staff said.' },
          max_altitude_ft: { type: 'NUMBER', description: 'Highest point in feet, only if staff said.' },
          highlights: { type: 'STRING', description: 'Highlights, only if staff gave them.' },
          notes: { type: 'STRING', description: 'Notes, only if staff gave them.' },
          replaces: REPLACES,
        },
        required: ['name', 'duration_days'],
      },
    });
  }
  if (allowed.includes('vendor')) {
    out.push({
      name: TOOL_VENDOR,
      description: 'Prepare a DRAFT new vendor for the directory. Nothing is saved until staff tap Approve. Call it only when staff clearly ask to add a vendor. It cannot change a vendor that already exists.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'The vendor or person name.' },
          service: { type: 'STRING', enum: [...SERVICE_TYPES], description: 'The kind of service.' },
          contact_name: { type: 'STRING', description: 'A contact person, only if staff gave one.' },
          phone: { type: 'STRING', description: 'The phone number staff gave. Do not invent one.' },
          rate: { type: 'NUMBER', description: 'Rupees, only if staff said.' },
          rate_unit: { type: 'STRING', enum: [...RATE_UNITS], description: 'What the rate is per, only if a rate was given.' },
          tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Places, seasons or anything useful for matching, only what staff said.' },
          notes: { type: 'STRING', description: 'Notes, only if staff gave them.' },
          agreed_trek_ref: { type: 'STRING', description: 'The reference of a trek this vendor has been promised an amount for, for example T3.' },
          agreed_amount: { type: 'NUMBER', description: 'Rupees promised for that trek.' },
          replaces: REPLACES,
        },
        required: ['name', 'service'],
      },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ References

export interface TrekRef { ref: string; trek: Trek }
export interface VendorRef { ref: string; vendor: Vendor }
export interface Refs { treks: TrekRef[]; vendors: VendorRef[] }

/** T1, T2 ... for the live treks: upcoming first, then undated, then past. The same order the prompt lists them in. */
export function trekRefs(treks: Trek[], now: Date): TrekRef[] {
  const t = (x: Trek) => trekTiming(x, now);
  const up = treks.filter((x) => t(x) === 'upcoming').sort((a, b) => Date.parse(a.startDate!) - Date.parse(b.startDate!));
  const un = treks.filter((x) => t(x) === 'undated').sort((a, b) => a.name.localeCompare(b.name));
  const past = treks.filter((x) => t(x) === 'past').sort((a, b) => Date.parse(b.startDate!) - Date.parse(a.startDate!));
  return [...up, ...un, ...past].map((trek, i) => ({ ref: `T${i + 1}`, trek }));
}

/** V1, V2 ... for the vendors the prompt lists (the first 40, in the order the store keeps them). */
export function vendorRefs(vendors: Vendor[]): VendorRef[] {
  return vendors.slice(0, MAX_VENDOR_REFS).map((vendor, i) => ({ ref: `V${i + 1}`, vendor }));
}

// ----------------------------------------------------------------------------------------------- Reading a call

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A whole number above zero, or undefined. Gemini may send 5000 as 5000 or "5000". */
function rupeeValue(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[0-9]+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}

function modeValue(v: unknown): PaymentMode | undefined {
  const s = str(v).toLowerCase();
  return PAYMENT_MODES.find((m) => m.toLowerCase() === s);
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  const s = str(v).toLowerCase();
  return list.find((x) => x.toLowerCase() === s);
}

/** "2026-12-12" as noon that day, so the day is the same in any time zone. Anything else (or an impossible day) is undefined. */
function dayValue(v: unknown): Instant | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? toInstant(date) : undefined;
}

function tidyData<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

export interface ParsedCall { data: DraftData; replaces?: string }

/**
 * Turns a tool call into a draft. A reference that is not in this message's lists leaves the trek or vendor unset, so the card
 * asks staff to choose; the assistant's words never become an id.
 */
export function draftFromCall(tool: string, args: Record<string, unknown>, refs: Refs, now: Date): ParsedCall | null {
  const trekOf = (v: unknown) => refs.treks.find((r) => r.ref.toUpperCase() === str(v).toUpperCase())?.trek.id;
  const trekID = trekOf(args.trek_ref);
  const replaces = str(args.replaces).toUpperCase() || undefined;
  if (tool === TOOL_BOOKING) {
    const travellers = Array.isArray(args.travellers) ? args.travellers.map(str).filter((n) => n !== '').slice(0, MAX_PARTY) : [];
    return { replaces, data: tidyData<BookingDraftData>({ kind: 'booking', trekID, travellers, phone: str(args.phone).slice(0, 40), amountReceived: rupeeValue(args.amount_received), mode: modeValue(args.payment_mode) }) };
  }
  if (tool === TOOL_PAYMENT_IN) {
    return {
      replaces, data: tidyData<PaymentInDraftData>({
        kind: 'paymentIn', trekID, amount: rupeeValue(args.amount), mode: modeValue(args.payment_mode),
        date: dayValue(args.date) ?? toInstant(now), note: str(args.note).slice(0, 200), travellerQuery: str(args.traveller_name).slice(0, 80),
      }),
    };
  }
  if (tool === TOOL_PAYMENT_OUT) {
    const vendorID = refs.vendors.find((r) => r.ref.toUpperCase() === str(args.vendor_ref).toUpperCase())?.vendor.id;
    return {
      replaces, data: tidyData<PaymentOutDraftData>({
        kind: 'paymentOut', trekID, amount: rupeeValue(args.amount), mode: modeValue(args.payment_mode),
        date: dayValue(args.date) ?? toInstant(now), note: str(args.note).slice(0, 200), vendorID,
        vendorQuery: str(args.vendor_name).slice(0, 80), travellerQuery: str(args.traveller_name).slice(0, 80),
      }),
    };
  }
  if (tool === TOOL_TREK) {
    return {
      replaces, data: tidyData<TrekDraftData>({
        kind: 'trek', name: str(args.name).slice(0, 120), region: str(args.region).slice(0, 120), durationDays: rupeeValue(args.duration_days),
        difficulty: oneOf(DIFFICULTIES, args.difficulty), startDate: dayValue(args.start_date), pricePerPerson: rupeeValue(args.price_per_person),
        seats: rupeeValue(args.seats), maxAltitudeFt: rupeeValue(args.max_altitude_ft), highlights: str(args.highlights).slice(0, 500), notes: str(args.notes).slice(0, 500),
      }),
    };
  }
  if (tool === TOOL_VENDOR) {
    const tags = Array.isArray(args.tags) ? args.tags.map(str).filter((t) => t !== '').slice(0, 10) : [];
    const agreedAmount = rupeeValue(args.agreed_amount);
    return {
      replaces, data: tidyData<VendorDraftData>({
        kind: 'vendor', name: str(args.name).slice(0, 120), service: oneOf(SERVICE_TYPES, args.service), contactName: str(args.contact_name).slice(0, 120),
        phone: str(args.phone).slice(0, 40), rate: rupeeValue(args.rate), rateUnit: oneOf(RATE_UNITS, args.rate_unit), tags, notes: str(args.notes).slice(0, 500),
        agreedTrekID: agreedAmount === undefined ? undefined : trekOf(args.agreed_trek_ref), agreedAmount,
      }),
    };
  }
  return null;
}

// --------------------------------------------------------------------------------------------- Matching people

const words = (q: string) => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');

/**
 * Live bookings on a trek that a typed name could mean. Matches when every word typed appears in some traveller's
 * name (so "Rohit" finds "Rohit Sharma" and "Rohit Verma"), or the typed digits are part of the phone number.
 */
export function matchBookings(bookings: Booking[], trekID: Id, query: string, includeCancelled = false): Booking[] {
  const live = bookings.filter((b) => b.trekID === trekID && (includeCancelled || !isCancelled(b)));
  const w = words(query);
  const digits = query.replace(/\D/g, '');
  if (w.length === 0) return [];
  return live.filter((b) => {
    const names = b.travellers.map((n) => n.toLowerCase());
    if (w.every((x) => names.some((n) => n.includes(x)))) return true;
    return digits.length >= 6 && b.phone.replace(/\D/g, '').includes(digits);
  });
}

/** Vendors a typed name could mean: every word typed appears in the name. */
export function matchVendors(vendors: Vendor[], query: string): Vendor[] {
  const w = words(query);
  if (w.length === 0) return [];
  return vendors.filter((v) => { const n = v.name.toLowerCase(); return w.every((x) => n.includes(x)); });
}

// ----------------------------------------------------------------------------------------------- The card

export interface ChoiceOption { value: string; label: string; detail?: string }
export type ChoiceField = 'trek' | 'booking' | 'mode' | 'vendor' | 'service' | 'rateUnit' | 'difficulty';
export interface Choice { field: ChoiceField; prompt: string; options: ChoiceOption[] }
export interface DraftRow { label: string; value: string; strong?: boolean }

export interface DraftView {
  title: string;
  rows: DraftRow[];
  sums: string[];
  warnings: string[];
  problems: string[];
  choice?: Choice;
  /** True when Approve may be tapped. */
  canApprove: boolean;
  /** True when Approve needs the second, deliberate tap ("Add anyway") because of a warning. */
  needsAnyway: boolean;
}

export interface DraftDeps { treks: TrekStore; bookings: BookingStore; ledger: LedgerStore; vendors: VendorStore }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Sat 12 Dec 2026", so "next Saturday" can be checked at a glance. */
export function fmtDay(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${DAYS[x.getDay()]} ${fmtDate(x)}`;
}

const trekWhen = (t: Trek) => (t.startDate ? `${fmtDay(t.startDate)} to ${fmtDay(trekEndDate(t) ?? new Date(t.startDate))}` : 'Available on request');

function trekChoices(treks: Trek[], now: Date, includePast: boolean): ChoiceOption[] {
  return trekRefs(treks, now).filter((r) => includePast || trekTiming(r.trek, now) !== 'past')
    .slice(0, 12).map((r) => ({ value: r.trek.id, label: r.trek.name, detail: trekWhen(r.trek) }));
}

const modeChoice = (): Choice => ({ field: 'mode', prompt: 'How was it paid?', options: PAYMENT_MODES.map((m) => ({ value: m, label: m })) });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const travellerLabel = (b: Booking) => `${b.travellers[0]}${partySize(b) > 1 ? ` + ${partySize(b) - 1}` : ''}`;

/** Whether a role may save a draft of this kind. Checked again at Approve. */
export function mayApprove(kind: DraftKind, role: Role | undefined): boolean { return draftsAllowed(role).includes(kind); }

/**
 * Everything the card shows, worked out from the phone's data as it is now. Nothing here is written, and Approve uses the same
 * checks, so a draft that shows a problem cannot be approved.
 */
export function viewDraft(d: Draft, deps: DraftDeps, role: Role | undefined, now: Date = new Date()): DraftView {
  switch (d.data.kind) {
    case 'booking': return viewBooking(d.data, deps, role, now);
    case 'paymentIn': return viewPaymentIn(d.data, deps, role, now);
    case 'paymentOut': return viewPaymentOut(d.data, deps, role, now);
    case 'trek': return viewTrek(d.data, deps, role, now);
    case 'vendor': return viewVendor(d.data, deps, role, now);
  }
}

function finish(kind: DraftKind, role: Role | undefined, v: Omit<DraftView, 'canApprove' | 'needsAnyway'>): DraftView {
  const problems = mayApprove(kind, role) ? v.problems : ['Your role cannot save this.', ...v.problems];
  return { ...v, problems, canApprove: problems.length === 0 && v.choice === undefined, needsAnyway: v.warnings.length > 0 };
}

function viewBooking(d: BookingDraftData, deps: DraftDeps, role: Role | undefined, now: Date): DraftView {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sums: string[] = [];
  const rows: DraftRow[] = [];
  let choice: Choice | undefined;
  const trek = d.trekID === undefined ? undefined : deps.treks.trek(d.trekID);

  if (!trek) {
    rows.push({ label: 'Trek', value: 'Not chosen yet' });
    choice = { field: 'trek', prompt: 'Which trek?', options: trekChoices(deps.treks.treks, now, false) };
    problems.push(d.trekID === undefined ? 'Choose the trek.' : 'That trek no longer exists.');
  } else {
    rows.push({ label: 'Trek', value: `${trek.name}\n${trekWhen(trek)}`, strong: true });
    if (trekTiming(trek, now) === 'past') problems.push('This trek has already started or finished.');
  }
  const n = d.travellers.length;
  rows.push({ label: 'Travellers', value: n === 0 ? 'None given' : d.travellers.map((t, i) => (i === 0 && n > 1 ? `${t} (contact)` : t)).join('\n') });
  rows.push({ label: 'Phone', value: d.phone === '' ? 'Not given' : d.phone });
  if (n === 0) problems.push('Add at least one traveller name (use Edit).');
  if (trek && n > 0) {
    if (trek.pricePerPerson !== undefined) rows.push({ label: 'Due', value: `${n} × ${rupees(trek.pricePerPerson)} = ${rupees(trek.pricePerPerson * n)}` });
    if (d.amountReceived !== undefined) {
      rows.push({ label: 'Received', value: `${rupees(d.amountReceived)}${d.mode ? ` by ${d.mode}` : ''}, today` });
      if (d.mode === undefined) {
        choice = choice ?? modeChoice();
        problems.push('Choose how the money was paid.');
      }
      if (d.amountReceived > MAX_AMOUNT) problems.push('That amount looks too large. Check the digits.');
    }
    const due = trek.pricePerPerson !== undefined ? trek.pricePerPerson * n : undefined;
    const status = LedgerStore.summary(due, d.amountReceived ?? 0);
    sums.push(`Payment status: ${status.status}${status.balance !== undefined && status.balance > 0 && (d.amountReceived ?? 0) > 0 ? `, balance ${rupees(status.balance)}` : ''}`);
    if (trek.seatsLeft !== undefined) {
      sums.push(n > trek.seatsLeft ? `Seats: only ${trek.seatsLeft} left` : `Seats: ${trek.seatsLeft} left → ${trek.seatsLeft - n} left`);
      if (n > trek.seatsLeft) problems.push(trek.seatsLeft === 0 ? 'This trek is sold out.' : `Only ${plural(trek.seatsLeft, 'seat')} left.`);
    } else sums.push('Seats are not tracked for this trek.');
    const first = d.travellers[0].toLowerCase();
    const dup = deps.bookings.bookingsFor(trek.id).find((b) => b.travellers[0]?.toLowerCase() === first);
    if (dup) warnings.push(`${dup.travellers[0]} already has a booking on this trek (${plural(partySize(dup), 'seat')}). Approve only if this is another booking.`);
  }
  return finish('booking', role, { title: 'DRAFT BOOKING', rows, sums, warnings, problems, choice });
}

/** The rows and checks shared by money in and money out: amount, how, when. */
function moneyRows(d: { amount?: number; mode?: PaymentMode; date: Instant }, now: Date, problems: string[], warnings: string[]): DraftRow[] {
  if (d.amount === undefined) problems.push('Say how much (use Edit).');
  else if (d.amount > MAX_AMOUNT) problems.push('That amount looks too large. Check the digits.');
  if (Date.parse(d.date) > now.getTime() + 86_400_000) warnings.push('This date is in the future.');
  return [
    { label: 'Amount', value: d.amount === undefined ? 'Not given' : rupees(d.amount), strong: true },
    { label: 'Paid by', value: d.mode ?? 'Not given' },
    { label: 'Date', value: fmtDay(d.date) + (dayKey(d.date) === dayKey(toInstant(now)) ? ' (today)' : '') },
  ];
}

function bookingChoice(deps: DraftDeps, trek: Trek, query: string, includeCancelled: boolean): { choice?: Choice; problem?: string } {
  const all = deps.bookings.bookingsFor(trek.id, includeCancelled);
  const matches = matchBookings(all, trek.id, query, includeCancelled);
  const pool = matches.length > 0 ? matches : all;
  if (pool.length === 0) return { problem: 'There are no bookings on this trip yet. Add the booking first.' };
  const option = (b: Booking): ChoiceOption => {
    const s = deps.ledger.paymentSummary(b, trek);
    return { value: b.id, label: travellerLabel(b) + (isCancelled(b) ? ' (cancelled)' : ''), detail: s.due !== undefined ? `Due ${rupees(s.due)} · received ${rupees(s.received)}` : `Received ${rupees(s.received)}` };
  };
  return {
    problem: 'Choose the traveller.',
    choice: {
      field: 'booking', options: pool.slice(0, 12).map(option),
      prompt: matches.length === 0 ? `No booking on this trip matches “${query}”. Choose one` : `${plural(matches.length, 'booking')} match “${query}”. Which one?`,
    },
  };
}

function viewPaymentIn(d: PaymentInDraftData, deps: DraftDeps, role: Role | undefined, now: Date): DraftView {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sums: string[] = [];
  let choice: Choice | undefined;
  const trek = d.trekID === undefined ? undefined : deps.treks.trek(d.trekID);
  const rows = moneyRows(d, now, problems, warnings);

  if (!trek) {
    rows.push({ label: 'Trip', value: 'Not chosen yet' });
    choice = { field: 'trek', prompt: 'Which trip?', options: trekChoices(deps.treks.treks, now, true) };
    problems.push(d.trekID === undefined ? 'Choose the trip.' : 'That trek no longer exists.');
  } else {
    rows.push({ label: 'Trip', value: trek.name });
    const booking = d.bookingID === undefined ? undefined : deps.bookings.booking(d.bookingID);
    if (booking && (booking.trekID !== trek.id || isCancelled(booking))) {
      problems.push('That booking is not on this trip, or it is cancelled.');
    } else if (booking) {
      rows.push({ label: 'Traveller', value: travellerLabel(booking) });
      const before = deps.ledger.paymentSummary(booking, trek);
      if (before.due !== undefined) sums.push(`Booking due ${rupees(before.due)} · received so far ${rupees(before.received)}.`);
      if (d.amount !== undefined) {
        const after = LedgerStore.summary(before.due, before.received + d.amount);
        sums.push(after.status === before.status ? `Status stays ${after.status}.` : `The booking moves from ${before.status} to ${after.status}.`);
        if (before.due !== undefined && before.received + d.amount > before.due) warnings.push(`This is ${rupees(before.received + d.amount - before.due)} more than the booking is due.`);
      }
      const day = dayKey(d.date);
      const same = deps.ledger.entries.find((e) => e.kind === 'Money in' && e.bookingID === booking.id && e.amount === d.amount && dayKey(e.date) === day && e.shares[0]?.trekID === trek.id);
      if (same) warnings.push(`Possible duplicate: ${rupees(same.amount)} was already recorded for ${booking.travellers[0]} on ${fmtDate(same.date)}.`);
    } else {
      rows.push({ label: 'Traveller', value: d.travellerQuery === '' ? 'Not chosen yet' : `“${d.travellerQuery}” (not chosen yet)` });
      const r = bookingChoice(deps, trek, d.travellerQuery, false);
      if (r.problem) problems.push(r.problem);
      if (r.choice) choice = r.choice;
    }
  }
  if (d.mode === undefined) { choice = choice ?? modeChoice(); problems.push('Choose how it was paid.'); }
  return finish('paymentIn', role, { title: 'DRAFT PAYMENT RECEIVED', rows, sums, warnings, problems, choice });
}

function viewPaymentOut(d: PaymentOutDraftData, deps: DraftDeps, role: Role | undefined, now: Date): DraftView {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sums: string[] = [];
  let choice: Choice | undefined;
  const trek = d.trekID === undefined ? undefined : deps.treks.trek(d.trekID);
  const rows = moneyRows(d, now, problems, warnings);
  const refund = d.vendorID === undefined && d.vendorQuery === '' && d.travellerQuery !== '';
  const vendor = d.vendorID === undefined ? undefined : deps.vendors.vendor(d.vendorID);

  if ((d.vendorID !== undefined || d.vendorQuery !== '') && (d.bookingID !== undefined || d.travellerQuery !== '')) problems.push('Choose either a vendor or a traveller, not both (use Edit).');
  if (d.vendorID !== undefined && !vendor) problems.push('That vendor no longer exists.');

  if (!trek) {
    rows.push({ label: 'Trip', value: 'Not chosen yet' });
    choice = { field: 'trek', prompt: 'Which trip?', options: trekChoices(deps.treks.treks, now, true) };
    problems.push(d.trekID === undefined ? 'Choose the trip.' : 'That trek no longer exists.');
  } else rows.push({ label: 'Trip', value: trek.name });

  if (vendor) {
    rows.push({ label: 'Paid to', value: `${vendor.name} · ${vendor.service}` });
    if (trek && d.amount !== undefined) {
      const agreed = vendorAgreed(vendor, trek.id);
      const paid = deps.ledger.paidToVendor(vendor.id, trek.id);
      if (agreed > 0) {
        sums.push(`Agreed ${rupees(agreed)} · paid so far ${rupees(paid)}`);
        const after = agreed - paid - d.amount;
        sums.push(after > 0 ? `After this: ${rupees(after)} still owed` : `After this: paid ${rupees(paid + d.amount)}, nothing owed`);
        if (after < 0) warnings.push(`This is ${rupees(-after)} more than was agreed for this trip.`);
      } else sums.push(`No amount agreed for this trip yet · paid so far ${rupees(paid)}`);
      const day = dayKey(d.date);
      const same = deps.ledger.entries.find((e) => e.kind === 'Money out' && e.vendorID === vendor.id && e.amount === d.amount && dayKey(e.date) === day && e.shares[0]?.trekID === trek.id);
      if (same) warnings.push(`Possible duplicate: ${rupees(same.amount)} to ${vendor.name} for this trip was already recorded on ${fmtDate(same.date)}.`);
    }
  } else if (refund && trek) {
    const booking = d.bookingID === undefined ? undefined : deps.bookings.booking(d.bookingID);
    if (booking && booking.trekID === trek.id) {
      rows.push({ label: 'Refund to', value: travellerLabel(booking) });
      const net = deps.ledger.netReceivedForBooking(booking.id);
      sums.push(`Received from them, less refunds so far: ${rupees(net)}`);
      if (d.amount !== undefined && d.amount > net) warnings.push(`This is ${rupees(d.amount - Math.max(0, net))} more than they have paid.`);
      const day = dayKey(d.date);
      const same = deps.ledger.entries.find((e) => e.kind === 'Money out' && e.bookingID === booking.id && e.amount === d.amount && dayKey(e.date) === day);
      if (same) warnings.push(`Possible duplicate: a refund of ${rupees(same.amount)} to ${booking.travellers[0]} was already recorded on ${fmtDate(same.date)}.`);
    } else if (booking) problems.push('That booking is not on this trip.');
    else {
      rows.push({ label: 'Refund to', value: `“${d.travellerQuery}” (not chosen yet)` });
      const r = bookingChoice(deps, trek, d.travellerQuery, true);
      if (r.problem) problems.push(r.problem);
      if (r.choice) choice = choice ?? r.choice;
    }
  } else if (d.vendorID === undefined && !refund) {
    const matches = matchVendors(deps.vendors.vendors, d.vendorQuery);
    const pool = matches.length > 0 ? matches : deps.vendors.vendors;
    rows.push({ label: 'Paid to', value: d.vendorQuery === '' ? 'Not chosen yet' : `“${d.vendorQuery}” (not chosen yet)` });
    if (pool.length === 0) problems.push('There are no vendors yet. Add the vendor first.');
    else {
      choice = choice ?? {
        field: 'vendor', options: pool.slice(0, 12).map((v) => ({ value: v.id, label: v.name, detail: v.service })),
        prompt: d.vendorQuery === '' ? 'Who was paid? Choose the vendor' : matches.length === 0 ? `No vendor matches “${d.vendorQuery}”. Choose one` : `${plural(matches.length, 'vendor')} match “${d.vendorQuery}”. Which one?`,
      };
      problems.push('Choose the vendor, or say it is a refund to a traveller.');
    }
  }
  if (d.mode === undefined) { choice = choice ?? modeChoice(); problems.push('Choose how it was paid.'); }
  return finish('paymentOut', role, { title: 'DRAFT PAYMENT OUT', rows, sums, warnings, problems, choice });
}

function viewTrek(d: TrekDraftData, deps: DraftDeps, role: Role | undefined, now: Date): DraftView {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sums: string[] = [];
  let choice: Choice | undefined;
  const rows: DraftRow[] = [{ label: 'Name', value: d.name === '' ? 'Not given' : d.name, strong: true }];
  if (d.name === '') problems.push('Give the trek a name (use Edit).');
  const end = d.startDate && d.durationDays ? new Date(startOfDay(d.startDate).getTime() + (d.durationDays - 1) * 86_400_000 + 43_200_000) : undefined;
  rows.push({ label: 'Dates', value: d.startDate ? `${fmtDay(d.startDate)}${end ? ` to ${fmtDay(end)}` : ''}` : 'Available on request (no date)' });
  rows.push({ label: 'Length', value: `${d.durationDays === undefined ? 'Not given' : plural(d.durationDays, 'day')}${d.difficulty ? ` · ${d.difficulty}` : ''}` });
  if (d.durationDays === undefined) problems.push('Say how many days (use Edit).');
  if (d.difficulty === undefined) {
    choice = { field: 'difficulty', prompt: 'How hard is it?', options: DIFFICULTIES.map((x) => ({ value: x, label: x })) };
    problems.push('Choose the difficulty.');
  }
  rows.push({ label: 'Price', value: d.pricePerPerson === undefined ? 'Not given (to be confirmed)' : `${rupees(d.pricePerPerson)} per person` });
  rows.push({ label: 'Seats', value: d.startDate ? (d.seats === undefined ? 'Not tracked' : String(d.seats)) : 'Not tracked (no date)' });
  rows.push({ label: 'Region', value: d.region === '' ? 'Not given. Add it in Edit.' : d.region });
  if (d.maxAltitudeFt !== undefined) rows.push({ label: 'Altitude', value: `${d.maxAltitudeFt} ft` });
  if (d.highlights !== '') rows.push({ label: 'Highlights', value: d.highlights });
  if (d.notes !== '') rows.push({ label: 'Notes', value: d.notes });
  if (d.seats !== undefined && !d.startDate) sums.push('Seats are only tracked for a trek with a date, so the seat count is left out.');
  if (d.startDate && Date.parse(d.startDate) < startOfDay(now).getTime()) warnings.push('This date has already passed, so the trek will count as past.');
  const clash = d.name === '' ? undefined : deps.treks.treks.find((t) => t.name.toLowerCase() === d.name.toLowerCase() && (t.startDate === undefined ? d.startDate === undefined : d.startDate !== undefined && dayKey(t.startDate) === dayKey(d.startDate)));
  if (clash) warnings.push(`A trek called ${clash.name}${clash.startDate ? ` on ${fmtDate(clash.startDate)}` : ''} is already in Treks. Approve only if this is another one.`);
  sums.push('It will appear in Treks and in the assistant’s list of treks.');
  return finish('trek', role, { title: 'DRAFT TREK', rows, sums, warnings, problems, choice });
}

function viewVendor(d: VendorDraftData, deps: DraftDeps, role: Role | undefined, now: Date): DraftView {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sums: string[] = [];
  let choice: Choice | undefined;
  const rows: DraftRow[] = [{ label: 'Name', value: d.name === '' ? 'Not given' : d.name, strong: true }];
  if (d.name === '') problems.push("Enter the vendor's name (use Edit).");
  rows.push({ label: 'Service', value: d.service ?? 'Not chosen yet' });
  if (d.service === undefined) {
    choice = { field: 'service', prompt: 'What kind of service?', options: SERVICE_TYPES.map((x) => ({ value: x, label: x })) };
    problems.push('Choose the service.');
  }
  const contact = [d.contactName, d.phone].filter((x) => x !== '').join(' · ');
  rows.push({ label: 'Contact', value: contact === '' ? 'Not given' : contact });
  if (d.rate !== undefined) {
    rows.push({ label: 'Rate', value: `${rupees(d.rate)} ${d.rateUnit ?? '(per what?)'}` });
    if (d.rateUnit === undefined) {
      choice = choice ?? { field: 'rateUnit', prompt: 'The rate is…', options: RATE_UNITS.map((x) => ({ value: x, label: x })) };
      problems.push('Choose what the rate is per.');
    }
  } else rows.push({ label: 'Rate', value: 'Not fixed' });
  if (d.tags.length > 0) rows.push({ label: 'Tags', value: d.tags.join(', ') });
  if (d.notes !== '') rows.push({ label: 'Notes', value: d.notes });
  if (d.agreedAmount !== undefined) {
    const t = d.agreedTrekID === undefined ? undefined : deps.treks.trek(d.agreedTrekID);
    rows.push({ label: 'Agreed', value: `${rupees(d.agreedAmount)} for ${t ? t.name : 'a trip (not chosen yet)'}` });
    if (!t) {
      choice = choice ?? { field: 'trek', prompt: 'Which trip was it agreed for?', options: trekChoices(deps.treks.treks, now, false) };
      problems.push('Choose the trip the amount was agreed for.');
    }
  }
  if (d.name !== '' && d.service !== undefined) {
    const exact = deps.vendors.vendors.some((v) => v.service === d.service && v.name.toLowerCase() === d.name.toLowerCase());
    if (exact) problems.push('A vendor with this name and service already exists. To change it, open it in Vendors.');
    else sums.push('Not in your vendors yet. No vendor with this name and service.');
  }
  const lower = d.name.toLowerCase();
  const near = d.name === '' ? undefined : deps.vendors.vendors.find((v) => {
    const n = v.name.toLowerCase();
    return n !== lower && !(n === lower && v.service === d.service) && (n.includes(lower) || lower.includes(n));
  });
  if (near) warnings.push(`A vendor called ${near.name} (${near.service}) is already in Vendors. Approve only if this is a different one.`);
  return finish('vendor', role, { title: 'DRAFT VENDOR', rows, sums, warnings, problems, choice });
}

// ------------------------------------------------------------------------------------- Settling a choice

/** The draft's data after staff settle a choice the card asked for. Choosing a trip clears a traveller chosen for another trip. */
export function choose(data: DraftData, field: ChoiceField, value: string): DraftData {
  const d = { ...data } as Record<string, unknown>;
  switch (field) {
    case 'mode': d.mode = value; break;
    case 'difficulty': d.difficulty = value; break;
    case 'service': d.service = value; break;
    case 'rateUnit': d.rateUnit = value; break;
    case 'trek':
      if (data.kind === 'vendor') d.agreedTrekID = value;
      else { d.trekID = value; delete d.bookingID; }
      break;
    case 'booking': d.bookingID = value; break;
    case 'vendor': d.vendorID = value; break;
  }
  return d as unknown as DraftData;
}

// --------------------------------------------------------------------------------- Applying (same code as the forms)

export interface Applied { text: string; recordIDs: Id[] }

/**
 * Saves a draft the same way the form does. The caller has checked `viewDraft` first; this checks the parts that can fail
 * again (seats, amounts), and either saves everything or throws and saves nothing.
 */
export function applyDraft(d: Draft, deps: DraftDeps, role: Role | undefined, now: Date = new Date()): Applied {
  if (!mayApprove(d.data.kind, role)) throw new AppError('forbidden', 'Your role cannot save this.');
  const data = d.data;
  switch (data.kind) {
    case 'booking': {
      if (data.trekID === undefined) throw new AppError('tripRequired', 'Choose the trek.');
      if (data.amountReceived !== undefined && data.mode === undefined) throw new AppError('modeRequired', 'Choose how the money was paid.');
      const b = deps.bookings.confirm({
        trekID: data.trekID, travellers: data.travellers, phone: data.phone, amountReceived: data.amountReceived, mode: data.mode,
        trekStore: deps.treks, ledger: deps.ledger, now,
      });
      const trek = deps.treks.trek(b.trekID);
      return { text: `Booking added · ${travellerLabel(b)} · ${plural(b.travellers.length, 'seat')}${trek ? ` on ${trek.name}` : ''}`, recordIDs: [b.id] };
    }
    case 'paymentIn': {
      const trek = data.trekID === undefined ? undefined : deps.treks.trek(data.trekID);
      const booking = data.bookingID === undefined ? undefined : deps.bookings.booking(data.bookingID);
      if (!trek) throw new AppError('tripRequired', 'Choose the trip this belongs to.');
      if (!booking || booking.trekID !== trek.id || isCancelled(booking)) throw new AppError('travellerRequired', 'Choose the traveller this money came from.');
      if (data.amount === undefined) throw new AppError('invalidAmount', 'Enter an amount greater than zero.');
      if (data.mode === undefined) throw new AppError('modeRequired', 'Choose how it was paid.');
      const entry: LedgerEntry = makeEntry({
        date: data.date, kind: 'Money in', amount: data.amount, mode: data.mode, party: booking.travellers[0], note: data.note,
        bookingID: booking.id, customerName: booking.travellers[0], shares: [{ trekID: trek.id, trekName: trek.name, amount: data.amount }],
      });
      const saved = deps.ledger.add(entry);
      return { text: `Payment recorded · ${rupees(saved.amount)} by ${saved.mode} · ${booking.travellers[0]}`, recordIDs: [saved.id] };
    }
    case 'paymentOut': {
      const trek = data.trekID === undefined ? undefined : deps.treks.trek(data.trekID);
      if (!trek) throw new AppError('tripRequired', 'Choose the trip this belongs to.');
      if (data.amount === undefined) throw new AppError('invalidAmount', 'Enter an amount greater than zero.');
      if (data.mode === undefined) throw new AppError('modeRequired', 'Choose how it was paid.');
      const vendor = data.vendorID === undefined ? undefined : deps.vendors.vendor(data.vendorID);
      const booking = data.bookingID === undefined ? undefined : deps.bookings.booking(data.bookingID);
      if (vendor && booking) throw new AppError('counterpartConflict', 'Choose either a vendor or a traveller, not both.');
      if (!vendor && !booking) throw new AppError('counterpartRequired', 'Choose the vendor, or the traveller being refunded.');
      if (booking && booking.trekID !== trek.id) throw new AppError('travellerRequired', 'That booking is not on this trip.');
      const entry: LedgerEntry = makeEntry({
        date: data.date, kind: 'Money out', amount: data.amount, mode: data.mode, note: data.note,
        party: vendor ? vendor.name : booking!.travellers[0],
        ...(vendor ? { vendorID: vendor.id, vendorName: vendor.name } : { bookingID: booking!.id, customerName: booking!.travellers[0] }),
        shares: [{ trekID: trek.id, trekName: trek.name, amount: data.amount }],
      });
      const saved = deps.ledger.add(entry);
      return { text: `Payment out recorded · ${rupees(saved.amount)} by ${saved.mode} · ${vendor ? vendor.name : `refund to ${booking!.travellers[0]}`}`, recordIDs: [saved.id] };
    }
    case 'trek': {
      if (data.name === '') throw new AppError('missingName', 'Give the trek a name.');
      if (data.durationDays === undefined || data.durationDays < 1) throw new AppError('badDays', 'Days must be a number, 1 or more.');
      const dated = data.startDate !== undefined;
      const trek = makeTrek(tidyData({
        name: data.name, region: data.region, durationDays: data.durationDays, difficulty: data.difficulty ?? 'Moderate',
        maxAltitudeFt: data.maxAltitudeFt, pricePerPerson: data.pricePerPerson,
        startDate: dated ? toInstant(startOfDay(data.startDate!)) : undefined,
        seatsLeft: dated ? data.seats : undefined, seatCapacity: dated ? data.seats : undefined,
        highlights: data.highlights, notes: data.notes,
      }));
      deps.treks.upsert(trek);
      return { text: `Trek added · ${trek.name}${trek.startDate ? ` · ${fmtDate(trek.startDate)}` : ''}`, recordIDs: [trek.id] };
    }
    case 'vendor': {
      if (data.service === undefined) throw new AppError('missingService', 'Choose the service.');
      const t = data.agreedTrekID === undefined ? undefined : deps.treks.trek(data.agreedTrekID);
      const v = makeVendor(tidyData({
        name: data.name, service: data.service, contactName: data.contactName, phone: data.phone, rate: data.rate,
        rateUnit: data.rateUnit ?? 'per trip', tags: data.tags.map((x) => x.toLowerCase()), notes: data.notes,
        agreements: t && data.agreedAmount !== undefined ? [{ trekID: t.id, trekName: t.name, amount: data.agreedAmount }] : [],
      }));
      const saved = deps.vendors.upsert(v);
      return { text: `Vendor added · ${saved.name} · ${saved.service}`, recordIDs: [saved.id] };
    }
  }
}

/** Fills in a traveller or vendor when the typed name matches exactly one on the chosen trek. Used when a draft arrives or a choice is made. */
export function resolveDraft(d: Draft, deps: DraftDeps): void {
  const data = d.data;
  if ((data.kind === 'paymentIn' || data.kind === 'paymentOut') && data.bookingID === undefined && data.trekID !== undefined && data.travellerQuery !== '' && !(data.kind === 'paymentOut' && (data.vendorID !== undefined || data.vendorQuery !== ''))) {
    const matches = matchBookings(deps.bookings.bookings, data.trekID, data.travellerQuery, data.kind === 'paymentOut');
    if (matches.length === 1) data.bookingID = matches[0].id;
  }
  if (data.kind === 'paymentOut' && data.vendorID === undefined && data.vendorQuery !== '') {
    const matches = matchVendors(deps.vendors.vendors, data.vendorQuery);
    if (matches.length === 1) data.vendorID = matches[0].id;
  }
}

/** One line the assistant is told about a draft, so it never claims something was saved when it was not. */
export function draftNote(d: Draft, deps: DraftDeps): string {
  const data = d.data;
  const trekOf = (id?: Id) => (id === undefined ? undefined : deps.treks.trek(id));
  let what: string;
  switch (data.kind) {
    case 'booking': {
      const t = trekOf(data.trekID);
      what = `booking for ${data.travellers[0] ?? 'nobody yet'}${data.travellers.length > 1 ? ` + ${data.travellers.length - 1}` : ''}${t ? ` on ${t.name}` : ''}`;
      break;
    }
    case 'paymentIn': {
      const t = trekOf(data.trekID);
      what = `payment received${data.amount !== undefined ? ` of ${rupees(data.amount)}` : ''} from ${data.travellerQuery || 'someone'}${t ? ` for ${t.name}` : ''}`;
      break;
    }
    case 'paymentOut': {
      const t = trekOf(data.trekID);
      const to = data.vendorID !== undefined ? deps.vendors.vendor(data.vendorID)?.name : undefined;
      what = `payment out${data.amount !== undefined ? ` of ${rupees(data.amount)}` : ''} to ${to ?? (data.vendorQuery || data.travellerQuery || 'someone')}${t ? ` for ${t.name}` : ''}`;
      break;
    }
    case 'trek': what = `trek ${data.name || '(no name yet)'}${data.startDate ? ` on ${fmtDate(data.startDate)}` : ''}`; break;
    case 'vendor': what = `vendor ${data.name || '(no name yet)'}${data.service ? ` (${data.service})` : ''}`; break;
  }
  return `${d.id} (${what})`;
}
