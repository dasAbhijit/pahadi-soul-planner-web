import { AppError } from './errors';
import { fmtDate, rupees } from './fmt';
import { dayKey, toInstant, type Id, type Instant } from './ids';
import {
  PAYMENT_MODES, isCancelled, makeEntry, partySize, trekEndDate, trekTiming,
  type Booking, type LedgerEntry, type PaymentMode, type Trek,
} from './models';
import type { Role } from './roles';
import { LedgerStore, MAX_AMOUNT, MAX_PARTY, type BookingStore, type TrekStore } from './stores';

/**
 * Chat actions: the assistant may DRAFT a booking or a payment received from what staff type. A draft is only a card.
 * Nothing is written until a person taps Approve (or saves it from the normal form), and Approve runs the same
 * code as the forms. The assistant never sees or names record ids: it names a trek by a short reference (T3), and the
 * app finds the traveller among the bookings on the phone.
 */

export const TOOL_BOOKING = 'draft_booking';
export const TOOL_PAYMENT_IN = 'draft_payment_received';
export const DRAFT_TOOLS: readonly string[] = [TOOL_BOOKING, TOOL_PAYMENT_IN];

/** At most this many cards from one reply. */
export const MAX_DRAFTS_PER_REPLY = 5;

export type DraftKind = 'booking' | 'paymentIn';
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

export type DraftData = BookingDraftData | PaymentInDraftData;

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

/** Which drafts a role may be offered. Staff never get money out, vendor or trek tools (none exist in this version). */
export function draftsAllowed(role: Role | undefined): DraftKind[] {
  if (role === undefined) return [];
  return ['booking', 'paymentIn'];
}

const MODE_ENUM = [...PAYMENT_MODES];

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
          replaces: { type: 'STRING', description: 'The id (D1, D2 ...) of an earlier draft this one replaces, when staff change that draft.' },
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
          replaces: { type: 'STRING', description: 'The id (D1, D2 ...) of an earlier draft this one replaces, when staff change that draft.' },
        },
        required: ['trek_ref', 'traveller_name', 'amount'],
      },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ Trek references

export interface TrekRef { ref: string; trek: Trek }

/** T1, T2 ... for the live treks: upcoming first, then undated, then past. The same order the prompt lists them in. */
export function trekRefs(treks: Trek[], now: Date): TrekRef[] {
  const t = (x: Trek) => trekTiming(x, now);
  const up = treks.filter((x) => t(x) === 'upcoming').sort((a, b) => Date.parse(a.startDate!) - Date.parse(b.startDate!));
  const un = treks.filter((x) => t(x) === 'undated').sort((a, b) => a.name.localeCompare(b.name));
  const past = treks.filter((x) => t(x) === 'past').sort((a, b) => Date.parse(b.startDate!) - Date.parse(a.startDate!));
  return [...up, ...un, ...past].map((trek, i) => ({ ref: `T${i + 1}`, trek }));
}

// ----------------------------------------------------------------------------------------------- Reading a call

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A whole number of rupees above zero, or undefined. Gemini may send 5000 as 5000 or "5000". */
function rupeeValue(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[0-9]+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}

function modeValue(v: unknown): PaymentMode | undefined {
  const s = str(v).toLowerCase();
  return PAYMENT_MODES.find((m) => m.toLowerCase() === s);
}

/** "2026-12-12" as noon that day, so the day is the same in any time zone. Anything else (or an impossible day) is undefined. */
function dayValue(v: unknown): Instant | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d, 12);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? toInstant(date) : undefined;
}

export interface ParsedCall { data: DraftData; replaces?: string }

/**
 * Turns a tool call into a draft. A reference that is not in this message's catalogue leaves the trek unset, so the card
 * asks staff to choose; the assistant's words never become an id.
 */
export function draftFromCall(tool: string, args: Record<string, unknown>, refs: TrekRef[], now: Date): ParsedCall | null {
  const trekID = refs.find((r) => r.ref.toUpperCase() === str(args.trek_ref).toUpperCase())?.trek.id;
  const replaces = str(args.replaces).toUpperCase() || undefined;
  if (tool === TOOL_BOOKING) {
    const travellers = Array.isArray(args.travellers) ? args.travellers.map(str).filter((n) => n !== '').slice(0, MAX_PARTY) : [];
    const amountReceived = rupeeValue(args.amount_received);
    const data: BookingDraftData = { kind: 'booking', trekID, travellers, phone: str(args.phone).slice(0, 40), amountReceived, mode: modeValue(args.payment_mode) };
    if (amountReceived === undefined) delete data.amountReceived;
    if (data.mode === undefined) delete data.mode;
    if (data.trekID === undefined) delete data.trekID;
    return { data, replaces };
  }
  if (tool === TOOL_PAYMENT_IN) {
    const data: PaymentInDraftData = {
      kind: 'paymentIn', trekID, amount: rupeeValue(args.amount), mode: modeValue(args.payment_mode),
      date: dayValue(args.date) ?? toInstant(now), note: str(args.note).slice(0, 200), travellerQuery: str(args.traveller_name).slice(0, 80),
    };
    if (data.amount === undefined) delete data.amount;
    if (data.mode === undefined) delete data.mode;
    if (data.trekID === undefined) delete data.trekID;
    return { data, replaces };
  }
  return null;
}

// --------------------------------------------------------------------------------------------- Matching people

/**
 * Live bookings on a trek that a typed name could mean. Matches when every word typed appears in some traveller's
 * name (so "Rohit" finds "Rohit Sharma" and "Rohit Verma"), or the typed digits are part of the phone number.
 */
export function matchBookings(bookings: Booking[], trekID: Id, query: string): Booking[] {
  const live = bookings.filter((b) => b.trekID === trekID && !isCancelled(b));
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  const digits = query.replace(/\D/g, '');
  if (words.length === 0) return [];
  return live.filter((b) => {
    const names = b.travellers.map((n) => n.toLowerCase());
    if (words.every((w) => names.some((n) => n.includes(w)))) return true;
    return digits.length >= 6 && b.phone.replace(/\D/g, '').includes(digits);
  });
}

// ----------------------------------------------------------------------------------------------- The card

export interface ChoiceOption { value: string; label: string; detail?: string }
export type ChoiceField = 'trek' | 'booking' | 'mode';
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

export interface DraftDeps { treks: TrekStore; bookings: BookingStore; ledger: LedgerStore }

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

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Whether a role may save a draft of this kind. Checked again at Approve. */
export function mayApprove(kind: DraftKind, role: Role | undefined): boolean { return draftsAllowed(role).includes(kind); }

/**
 * Everything the card shows, worked out from the phone's data as it is now. Nothing here is written, and Approve uses the same
 * checks, so a draft that shows a problem cannot be approved.
 */
export function viewDraft(d: Draft, deps: DraftDeps, role: Role | undefined, now: Date = new Date()): DraftView {
  return d.data.kind === 'booking' ? viewBooking(d.data, deps, role, now) : viewPaymentIn(d.data, deps, role, now);
}

function finish(v: Omit<DraftView, 'canApprove' | 'needsAnyway'>, allowed: boolean): DraftView {
  const problems = allowed ? v.problems : ['Your role cannot save this.', ...v.problems];
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
        choice = choice ?? { field: 'mode', prompt: 'How was it paid?', options: PAYMENT_MODES.map((m) => ({ value: m, label: m })) };
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
  return finish({ title: 'DRAFT BOOKING', rows, sums, warnings, problems, choice }, mayApprove('booking', role));
}

function viewPaymentIn(d: PaymentInDraftData, deps: DraftDeps, role: Role | undefined, now: Date): DraftView {
  const problems: string[] = [];
  const warnings: string[] = [];
  const sums: string[] = [];
  const rows: DraftRow[] = [];
  let choice: Choice | undefined;
  const trek = d.trekID === undefined ? undefined : deps.treks.trek(d.trekID);

  rows.push({ label: 'Amount', value: d.amount === undefined ? 'Not given' : rupees(d.amount), strong: true });
  rows.push({ label: 'Paid by', value: d.mode ?? 'Not given' });
  rows.push({ label: 'Date', value: fmtDay(d.date) + (dayKey(d.date) === dayKey(toInstant(now)) ? ' (today)' : '') });
  if (d.amount === undefined) problems.push('Say how much was received (use Edit).');
  else if (d.amount > MAX_AMOUNT) problems.push('That amount looks too large. Check the digits.');
  if (Date.parse(d.date) > now.getTime() + 86_400_000) warnings.push('This date is in the future.');

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
      rows.push({ label: 'Traveller', value: `${booking.travellers[0]}${partySize(booking) > 1 ? ` + ${partySize(booking) - 1}` : ''}` });
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
      const all = deps.bookings.bookingsFor(trek.id);
      const matches = matchBookings(all, trek.id, d.travellerQuery);
      const pool = matches.length > 0 ? matches : all;
      rows.push({ label: 'Traveller', value: d.travellerQuery === '' ? 'Not chosen yet' : `“${d.travellerQuery}” (not chosen yet)` });
      const option = (b: Booking): ChoiceOption => {
        const s = deps.ledger.paymentSummary(b, trek);
        return { value: b.id, label: `${b.travellers[0]}${partySize(b) > 1 ? ` + ${partySize(b) - 1}` : ''}`, detail: s.due !== undefined ? `Due ${rupees(s.due)} · received ${rupees(s.received)}` : `Received ${rupees(s.received)}` };
      };
      if (pool.length === 0) problems.push('There are no bookings on this trip yet. Add the booking first.');
      else {
        choice = {
          field: 'booking', options: pool.slice(0, 12).map(option),
          prompt: matches.length === 0 ? `No booking on this trip matches “${d.travellerQuery}”. Choose one` : `${plural(matches.length, 'booking')} match “${d.travellerQuery}”. Which one?`,
        };
        problems.push('Choose the traveller.');
      }
    }
  }
  if (d.mode === undefined) {
    choice = choice ?? { field: 'mode', prompt: 'How was it paid?', options: PAYMENT_MODES.map((m) => ({ value: m, label: m })) };
    problems.push('Choose how it was paid.');
  }
  return finish({ title: 'DRAFT PAYMENT RECEIVED', rows, sums, warnings, problems, choice }, mayApprove('paymentIn', role));
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
  if (data.kind === 'booking') {
    if (data.trekID === undefined) throw new AppError('tripRequired', 'Choose the trek.');
    if (data.amountReceived !== undefined && data.mode === undefined) throw new AppError('modeRequired', 'Choose how the money was paid.');
    const b = deps.bookings.confirm({
      trekID: data.trekID, travellers: data.travellers, phone: data.phone, amountReceived: data.amountReceived, mode: data.mode,
      trekStore: deps.treks, ledger: deps.ledger, now,
    });
    const who = `${b.travellers[0]}${b.travellers.length > 1 ? ` + ${b.travellers.length - 1}` : ''}`;
    const trek = deps.treks.trek(b.trekID);
    return { text: `Booking added · ${who} · ${plural(b.travellers.length, 'seat')}${trek ? ` on ${trek.name}` : ''}`, recordIDs: [b.id] };
  }
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

/** Fills in the traveller when the typed name matches exactly one booking on the chosen trek. Used when a draft arrives. */
export function resolveDraft(d: Draft, deps: DraftDeps): void {
  const data = d.data;
  if (data.kind !== 'paymentIn' || data.bookingID !== undefined || data.trekID === undefined) return;
  const matches = matchBookings(deps.bookings.bookings, data.trekID, data.travellerQuery);
  if (matches.length === 1) data.bookingID = matches[0].id;
}

/** One line the assistant is told about a draft, so it never claims something was saved when it was not. */
export function draftNote(d: Draft, deps: DraftDeps): string {
  const data = d.data;
  const trek = data.trekID === undefined ? undefined : deps.treks.trek(data.trekID);
  const what = data.kind === 'booking'
    ? `booking for ${data.travellers[0] ?? 'nobody yet'}${data.travellers.length > 1 ? ` + ${data.travellers.length - 1}` : ''}${trek ? ` on ${trek.name}` : ''}`
    : `payment received${data.amount !== undefined ? ` of ${rupees(data.amount)}` : ''} from ${data.travellerQuery || 'someone'}${trek ? ` for ${trek.name}` : ''}`;
  return `${d.id} (${what})`;
}
