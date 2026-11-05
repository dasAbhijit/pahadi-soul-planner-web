import { AppError } from './errors';
import { same } from './codec';
import { parseBooking, parseEntry, parseRule, parseTrek, parseVendor } from './codec';
import { type Id, type Instant, addDays, ms, newId, startOfDay, toInstant } from './ids';
import { JsonListFile, Observable, type KV } from './storage';
import { SyncClock, SyncList, stampRecord } from './syncrecord';
import { reconcileSeats, seatsBooked, type SeatConflict } from './syncmerge';
import {
  MAX_TAGS, amountIn, duplicatedTrek, isCancelled, isGeneral, makeBooking, makeEntry, makeRule, partySize, signedAmount, trekTiming,
  vendorTotalAgreed,
  type Booking, type EntryKind, type GuidanceRule, type LedgerEntry, type LedgerFilter, type LedgerScope, type PaymentMode,
  type PaymentStatus, type PaymentSummary, type ServiceType, type SyncFields, type Trek, type TripShare, type Vendor,
  type VendorStatement,
} from './models';

/**
 * Base for every record store: live records and deleted ones (tombstones) side by side, saved as one list.
 * Subclasses add the rules for their own kind of record.
 */
abstract class RecordStore<T extends SyncFields> extends Observable {
  protected disk: JsonListFile<T>;
  protected liveList: T[] = [];
  protected deletedList: T[] = [];

  constructor(kv: KV, key: string, parse: (o: unknown) => T | null, seed?: () => T[]) {
    super();
    this.disk = new JsonListFile(kv, key, parse);
    const saved = this.disk.read();
    if (saved !== null) {
      const { live, deleted } = SyncList.split(saved);
      this.deletedList = deleted;
      const stamped = SyncList.stampMissing(live, SyncClock.now());
      this.liveList = this.arrange(stamped ?? live);
      if (stamped) this.save();
    } else {
      this.liveList = this.arrange(seed ? seed() : []);
      if (seed) this.save();
    }
  }

  /** How live records are ordered. */
  protected arrange(list: T[]): T[] { return list; }

  private save() { this.disk.write([...this.liveList, ...this.deletedList]); }

  protected set(live: T[]) { this.liveList = this.arrange(live); this.save(); this.emit(); }

  /** Live records, as shown to staff. A new array whenever something changes. */
  get all(): T[] { return this.liveList; }

  /** Every record, live and deleted, for merging. */
  get syncRecords(): T[] { return [...this.liveList, ...this.deletedList]; }

  protected find(id: Id): T | undefined { return this.liveList.find((r) => r.id === id); }

  /** A record by id, live or deleted. */
  protected findAny(id: Id): T | undefined { return this.find(id) ?? this.deletedList.find((r) => r.id === id); }

  protected put(rec: T) {
    const i = this.liveList.findIndex((r) => r.id === rec.id);
    this.set(i >= 0 ? this.liveList.map((r, j) => (j === i ? rec : r)) : [...this.liveList, rec]);
  }

  /** Empties the store without leaving deletions behind. Used when someone signs out: the records belong to the sheet. */
  clearAll() {
    this.deletedList = [];
    this.set([]);
  }

  /** Swaps in a whole list (used when restoring a backup). Records missing from it are marked deleted. */
  replaceAll(list: T[]) {
    const r = SyncList.replace(this.liveList, this.deletedList, list, SyncClock.now());
    this.deletedList = r.deleted;
    this.set(r.live);
  }

  protected removeIds(ids: Set<Id>) {
    const r = SyncList.remove(ids, this.liveList, this.deletedList, SyncClock.now());
    this.deletedList = r.deleted;
    this.set(r.live);
  }

  /** Takes the merged list from a sync. No stamps change. */
  applyMerged(all: T[]) {
    const { live, deleted } = SyncList.split(all);
    const arranged = this.arrange(live);
    if (same(arranged, this.liveList) && same(deleted, this.deletedList)) return;
    this.deletedList = deleted;
    this.set(live);
  }
}

// ---------------------------------------------------------------- Treks

/**
 * Placeholder catalogue shown on first launch. Staff should edit or replace it. It has a fixed id and the oldest
 * possible stamp, so two fresh installs share one placeholder and any real edit or deletion beats it when phones merge.
 */
export function seedTreks(): Trek[] {
  return [{
    id: '00000000-0000-4000-8000-000000000001', name: 'Gorkhey – Samanden', region: 'Darjeeling hills, West Bengal',
    durationDays: 4, difficulty: 'Moderate', highlights: 'Quiet villages, forest trails, mountain views',
    notes: 'PLACEHOLDER: seeded from Instagram mentions only. Verify details, add dates and price.',
    updatedAt: '1970-01-01T00:00:00Z',
  }];
}

export class TrekStore extends RecordStore<Trek> {
  constructor(kv: KV, seed: () => Trek[] = seedTreks) { super(kv, 'pahadi.treks', parseTrek, seed); }

  get treks(): Trek[] { return this.liveList; }
  trek(id: Id): Trek | undefined { return this.find(id); }

  upsert(trek: Trek) { this.put(stampRecord(trek, this.findAny(trek.id))); }

  /**
   * Removes the starter trek if it is all the phone has and nobody has touched it. Called at sign-in: a signed-in
   * phone shows the company's treks, not a placeholder.
   */
  dropPlaceholder() {
    const seed = seedTreks()[0];
    const only = this.syncRecords.length === 1 ? this.syncRecords[0] : undefined;
    if (only && only.id === seed.id && only.updatedAt === seed.updatedAt && only.deletedAt === undefined) this.clearAll();
  }

  delete(ids: Iterable<Id>) { this.removeIds(new Set(ids)); }

  /**
   * Booking and cancelling take and return seats. Never goes below zero; does nothing if seats are not tracked.
   * Capacity does not move: seats left is capacity minus booked seats, and a booking changes the second.
   * Seats left is derived, so this does not change the trek's stamp.
   */
  adjustSeats(id: Id, by: number): number | null {
    const t = this.find(id);
    if (!t || t.seatsLeft === undefined) return null;
    const updated = { ...t, seatsLeft: Math.max(0, t.seatsLeft + by) };
    this.set(this.liveList.map((x) => (x.id === id ? updated : x)));
    return updated.seatsLeft;
  }

  /**
   * Plus/minus on a trek: staff change how many seats are on sale. Capacity moves with it, so the number survives
   * a merge, and the change counts as an edit of the trek.
   */
  adjustCapacity(id: Id, by: number): number | null {
    const t = this.find(id);
    if (!t || t.seatsLeft === undefined) return null;
    const next = Math.max(0, t.seatsLeft + by);
    const updated: Trek = stampRecord({
      ...t, seatsLeft: next,
      seatCapacity: t.seatCapacity === undefined ? undefined : Math.max(0, t.seatCapacity + (next - t.seatsLeft)),
    }, t);
    if (updated.seatCapacity === undefined) delete updated.seatCapacity;
    this.set(this.liveList.map((x) => (x.id === id ? updated : x)));
    return updated.seatsLeft ?? null;
  }

  duplicate(id: Id, startingOn: Instant | undefined): Trek | null {
    const source = this.find(id);
    if (!source) return null;
    const copy = stampRecord(duplicatedTrek(source, startingOn), undefined);
    this.set([...this.liveList, copy]);
    return copy;
  }

  upcoming(now = new Date()): Trek[] {
    return this.liveList.filter((t) => trekTiming(t, now) === 'upcoming').sort((a, b) => ms(a.startDate!) - ms(b.startDate!));
  }
  undated(now = new Date()): Trek[] {
    return this.liveList.filter((t) => trekTiming(t, now) === 'undated').sort((a, b) => a.name.localeCompare(b.name));
  }
  past(now = new Date()): Trek[] {
    return this.liveList.filter((t) => trekTiming(t, now) === 'past').sort((a, b) => ms(b.startDate!) - ms(a.startDate!));
  }

  /** Recomputes seats left from the live bookings. Seats are derived, so this does not change a trek's stamp. */
  reconcileSeats(bookings: Booking[]): SeatConflict[] {
    const { treks, conflicts } = reconcileSeats(this.liveList, bookings);
    if (!same(treks, this.liveList)) this.set(treks);
    return conflicts;
  }
}

// ------------------------------------------------------------- Bookings

export const MAX_PARTY = 10;

/**
 * Confirmed bookings. Confirming a booking reduces the trek's seats automatically; cancelling gives them back.
 * Traveller names and phone numbers stay on the device and are never sent to Gemini.
 */
export class BookingStore extends RecordStore<Booking> {
  constructor(kv: KV) { super(kv, 'pahadi.bookings', parseBooking); }

  get bookings(): Booking[] { return this.liveList; }

  /** Live bookings for a trek. Pass includeCancelled to also list cancelled ones (for refunds). */
  bookingsFor(trekID: Id, includeCancelled = false): Booking[] {
    return this.liveList.filter((b) => b.trekID === trekID && (includeCancelled || !isCancelled(b))).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  }

  booking(id: Id): Booking | undefined { return this.find(id); }

  /** Seats taken by live bookings for a trek. */
  activeSeats(trekID: Id): number { return seatsBooked(trekID, this.liveList); }

  /** Validates, takes the seats, records any payment, and saves, or throws without changing anything. */
  confirm(o: {
    trekID: Id; travellers: string[]; phone: string; payment?: PaymentStatus; amountReceived?: number; mode?: PaymentMode;
    trekStore: TrekStore; ledger?: LedgerStore; now?: Date;
  }): Booking {
    const now = o.now ?? new Date();
    const names = o.travellers.map((n) => n.trim());
    if (names.length === 0) throw new AppError('noTravellers', 'Add at least one traveller.');
    if (names.length > MAX_PARTY) throw new AppError('tooManyTravellers', `A single booking can have up to ${MAX_PARTY} travellers.`);
    if (names.some((n) => n === '')) throw new AppError('missingName', 'Enter a name for every traveller.');
    const trek = o.trekStore.trek(o.trekID);
    if (!trek) throw new AppError('trekNotFound', 'That trek no longer exists.');
    if (trekTiming(trek, now) === 'past') throw new AppError('trekNotUpcoming', 'This trek has already started or finished.');
    if (trek.seatsLeft !== undefined && names.length > trek.seatsLeft) {
      const left = trek.seatsLeft;
      throw new AppError('notEnoughSeats', left === 0 ? 'This trek is sold out.' : `Only ${left} seat${left === 1 ? '' : 's'} left.`, { left });
    }

    // Check the payment first so a bad amount changes nothing.
    const created = toInstant(now);
    const bookingID = newId();
    let receipt: LedgerEntry | undefined;
    if (o.amountReceived !== undefined && o.amountReceived > 0 && o.ledger) {
      const e = makeEntry({
        date: created, kind: 'Money in', amount: o.amountReceived, mode: o.mode ?? 'UPI', party: names[0], note: 'Payment at booking',
        bookingID, customerName: names[0], shares: [{ trekID: o.trekID, trekName: trek.name, amount: o.amountReceived }], createdAt: created,
      });
      LedgerStore.validate(e);
      receipt = e;
    }
    const status = o.payment ?? LedgerStore.summary(trek.pricePerPerson !== undefined ? trek.pricePerPerson * names.length : undefined, o.amountReceived ?? 0).status;

    o.trekStore.adjustSeats(o.trekID, -names.length); // no-op when seats aren't tracked
    const booking = stampRecord(makeBooking({
      id: bookingID, trekID: o.trekID, travellers: names, phone: o.phone.trim(), payment: status, amountReceived: o.amountReceived,
      createdAt: created,
    }), undefined);
    if (booking.amountReceived === undefined) delete booking.amountReceived;
    this.set([...this.liveList, booking]);
    if (receipt) { try { o.ledger?.add(receipt); } catch { /* the booking stands even if the receipt is refused */ } }
    return booking;
  }

  /** Marks the booking cancelled and gives its seats back. Cancelling twice does nothing. */
  cancel(id: Id, trekStore: TrekStore, now = new Date()) {
    const b = this.find(id);
    if (!b || isCancelled(b)) return;
    const cancelled = stampRecord({ ...b, cancelledAt: toInstant(now) }, b);
    this.set(this.liveList.map((x) => (x.id === id ? cancelled : x)));
    trekStore.adjustSeats(cancelled.trekID, partySize(cancelled));
  }

  /** Called when a trek is deleted so its bookings do not linger unseen. */
  removeBookingsForTrek(trekID: Id) {
    this.removeIds(new Set(this.liveList.filter((b) => b.trekID === trekID).map((b) => b.id)));
  }
}

// --------------------------------------------------------------- Ledger

export const MAX_AMOUNT = 100_000_000;

const newestFirst = (a: LedgerEntry, b: LedgerEntry) =>
  ms(b.date) - ms(a.date) || ms(b.createdAt) - ms(a.createdAt) || (a.id.toUpperCase() < b.id.toUpperCase() ? -1 : a.id.toUpperCase() > b.id.toUpperCase() ? 1 : 0);

const tidy = (e: LedgerEntry): LedgerEntry => ({ ...e, party: e.party.trim(), note: e.note.trim() });

/**
 * All money in and out, saved on the device. Entries are kept even when a booking is cancelled or a trek is
 * deleted, so the books always add up. Refunds are recorded as money out against the traveller.
 */
export class LedgerStore extends RecordStore<LedgerEntry> {
  constructor(kv: KV) { super(kv, 'pahadi.ledger', parseEntry); }

  /** Checks an entry without saving it. Every transaction names a trip and one counterpart. */
  static validate(e: LedgerEntry) {
    if (e.amount <= 0) throw new AppError('invalidAmount', 'Enter an amount greater than zero.');
    if (e.amount > MAX_AMOUNT) throw new AppError('tooLarge', 'That amount looks too large. Check the digits.');
    if (e.vendorID !== undefined && e.kind === 'Money in') throw new AppError('vendorOnlyForPayouts', 'A vendor can only be tagged on money out.');
    if (e.shares.length === 0) throw new AppError('tripRequired', 'Choose the trip this belongs to.');
    if (e.shares.length !== 1) throw new AppError('oneTripPerEntry', 'Each transaction belongs to one trip. Enter one per trip.');
    if (e.shares[0].amount !== e.amount) {
      const diff = e.amount - e.shares[0].amount;
      throw new AppError('sharesMismatch', diff > 0 ? `₹${diff} of the amount is not assigned to a trip yet.` : `The trip amounts add up to ₹${-diff} more than the entry.`);
    }
    if (e.kind === 'Money in') {
      if (e.bookingID === undefined) throw new AppError('travellerRequired', 'Choose the traveller this money came from.');
    } else {
      const hasVendor = e.vendorID !== undefined;
      const hasTraveller = e.bookingID !== undefined;
      if (!hasVendor && !hasTraveller) throw new AppError('counterpartRequired', 'Choose the vendor, or the traveller being refunded.');
      if (hasVendor && hasTraveller) throw new AppError('counterpartConflict', 'Choose either a vendor or a traveller, not both.');
    }
  }

  static summary(due: number | undefined, received: number): PaymentSummary {
    const realDue = (due ?? 0) > 0 ? due : undefined;
    const status: PaymentStatus = realDue !== undefined && received >= realDue ? 'Paid' : received > 0 ? 'Part paid' : 'Pending';
    return { due: realDue, received, status, balance: realDue === undefined ? undefined : Math.max(0, realDue - received) };
  }

  /** Splits an amount across trips as evenly as whole rupees allow. Leftover rupees go to the first trips, one each. */
  static evenSplit(amount: number, among: { id: Id; name: string }[]): TripShare[] {
    if (among.length === 0 || amount <= 0) return [];
    const base = Math.floor(amount / among.length);
    const extra = amount % among.length;
    return among.map((t, i) => ({ trekID: t.id, trekName: t.name, amount: base + (i < extra ? 1 : 0) }));
  }

  get entries(): LedgerEntry[] { return this.liveList; }

  // ---- Totals

  /** Fund balance: everything received minus everything paid out. */
  get balance(): number { return this.liveList.reduce((s, e) => s + signedAmount(e), 0); }
  get totalIn(): number { return this.total('Money in', { type: 'all' }); }
  get totalOut(): number { return this.total('Money out', { type: 'all' }); }

  total(kind: EntryKind, scope: LedgerScope): number {
    return this.liveList.filter((e) => e.kind === kind && matches(e, scope)).reduce((s, e) => s + amountIn(e, scope), 0);
  }
  receivedForTrek(id: Id) { return this.total('Money in', { type: 'trek', id }); }
  paidOutForTrek(id: Id) { return this.total('Money out', { type: 'trek', id }); }
  netForTrek(id: Id) { return this.receivedForTrek(id) - this.paidOutForTrek(id); }

  /** Money received from a traveller, less any refunds paid back to them. */
  netReceivedForBooking(id: Id): number { return this.liveList.filter((e) => e.bookingID === id).reduce((s, e) => s + signedAmount(e), 0); }

  paymentSummary(booking: Booking, trek: Trek | undefined): PaymentSummary {
    return LedgerStore.summary(trek?.pricePerPerson !== undefined ? trek.pricePerPerson * partySize(booking) : undefined, this.netReceivedForBooking(booking.id));
  }

  // ---- Vendors

  entriesForVendor(id: Id): LedgerEntry[] { return this.liveList.filter((e) => e.vendorID === id).sort(newestFirst); }

  paidToVendor(id: Id, trekID?: Id): number {
    const paid = this.liveList.filter((e) => e.vendorID === id && e.kind === 'Money out');
    return trekID === undefined ? paid.reduce((s, e) => s + e.amount, 0) : paid.reduce((s, e) => s + amountIn(e, { type: 'trek', id: trekID }), 0);
  }

  /** Paid and owed for one vendor, trip by trip. */
  statement(vendor: Vendor): VendorStatement {
    const paidEntries = this.liveList.filter((e) => e.vendorID === vendor.id && e.kind === 'Money out');
    const lines = vendor.agreements.map((a) => {
      const paid = this.paidToVendor(vendor.id, a.trekID);
      return { trekID: a.trekID, trekName: a.trekName, agreed: a.amount, paid, owed: Math.max(0, a.amount - paid) };
    });
    for (const e of paidEntries) for (const share of e.shares) {
      if (!lines.some((l) => l.trekID === share.trekID)) {
        const paid = this.paidToVendor(vendor.id, share.trekID);
        lines.push({ trekID: share.trekID, trekName: share.trekName, agreed: 0, paid, owed: 0 });
      }
    }
    lines.sort((a, b) => a.trekName.localeCompare(b.trekName));
    return {
      totalPaid: paidEntries.reduce((s, e) => s + e.amount, 0), totalAgreed: vendorTotalAgreed(vendor), trips: lines,
      unassignedPaid: paidEntries.filter(isGeneral).reduce((s, e) => s + e.amount, 0), owed: lines.reduce((s, l) => s + l.owed, 0),
    };
  }

  // ---- Lookups

  entriesForTrek(id: Id): LedgerEntry[] { return this.filtered({ type: 'trek', id }); }
  entriesForBooking(id: Id): LedgerEntry[] { return this.liveList.filter((e) => e.bookingID === id).sort(newestFirst); }

  filtered(scope: LedgerScope): LedgerEntry[];
  filtered(f: LedgerFilter): LedgerEntry[];
  filtered(arg: LedgerScope | LedgerFilter): LedgerEntry[] {
    if ('type' in arg) return this.liveList.filter((e) => matches(e, arg)).sort(newestFirst);
    const f = arg;
    const name = f.customer.trim().toLowerCase();
    const start = f.from ? startOfDay(f.from).getTime() : undefined;
    const end = f.to ? addDays(startOfDay(f.to), 1).getTime() : undefined;
    return this.liveList.filter((e) => {
      if (!matches(e, f.scope)) return false;
      if (f.kind !== undefined && e.kind !== f.kind) return false;
      if (name !== '' && !(e.customerName ?? '').toLowerCase().includes(name)) return false;
      if (f.vendorID !== undefined && e.vendorID !== f.vendorID) return false;
      if (start !== undefined && ms(e.date) < start) return false;
      if (end !== undefined && ms(e.date) >= end) return false;
      return true;
    }).sort(newestFirst);
  }

  /** Money in and money out for whatever a filter currently shows. */
  totals(list: LedgerEntry[], scope: LedgerScope): { credit: number; debit: number } {
    let credit = 0, debit = 0;
    for (const e of list) if (e.kind === 'Money in') credit += amountIn(e, scope); else debit += amountIn(e, scope);
    return { credit, debit };
  }

  // ---- Changes

  add(entry: LedgerEntry): LedgerEntry {
    const clean = stampRecord(tidy(entry), this.findAny(entry.id));
    LedgerStore.validate(clean);
    this.set([...this.liveList, clean]);
    return clean;
  }

  /** Adds several entries, or none if any one is invalid (used to split one cost across trips). */
  addAll(list: LedgerEntry[]): LedgerEntry[] {
    const now = SyncClock.now();
    const clean = list.map((e) => stampRecord(tidy(e), this.findAny(e.id), now));
    clean.forEach(LedgerStore.validate);
    this.set([...this.liveList, ...clean]);
    return clean;
  }

  update(entry: LedgerEntry) {
    const clean = stampRecord(tidy(entry), this.findAny(entry.id));
    LedgerStore.validate(clean);
    if (!this.liveList.some((e) => e.id === clean.id)) return;
    this.set(this.liveList.map((e) => (e.id === clean.id ? clean : e)));
  }

  remove(id: Id) { this.removeIds(new Set([id])); }
}

function matches(e: LedgerEntry, scope: LedgerScope): boolean {
  switch (scope.type) {
    case 'all': return true;
    case 'general': return isGeneral(e);
    case 'trek': return e.shares.some((s) => s.trekID === scope.id);
  }
}

// -------------------------------------------------------------- Vendors

/**
 * The vendor directory, saved on the device. Payments to vendors are not stored here: they are ordinary
 * money-out entries in the ledger, tagged with the vendor.
 */
export class VendorStore extends RecordStore<Vendor> {
  constructor(kv: KV) { super(kv, 'pahadi.vendors', parseVendor); }

  protected override arrange(list: Vendor[]): Vendor[] {
    return [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  get vendors(): Vendor[] { return this.liveList; }
  vendor(id: Id): Vendor | undefined { return this.find(id); }

  /** Adds or replaces a vendor after checking it. */
  upsert(vendor: Vendor): Vendor {
    const v: Vendor = {
      ...vendor, name: vendor.name.trim(), contactName: vendor.contactName.trim(), phone: vendor.phone.trim(),
      notes: vendor.notes.trim(), tags: vendor.tags.slice(0, MAX_TAGS),
    };
    if (v.name === '') throw new AppError('missingName', "Enter the vendor's name.");
    if (v.rate !== undefined && v.rate <= 0) throw new AppError('badRate', 'The rate must be a positive number.');
    if (!v.agreements.every((a) => a.amount > 0)) throw new AppError('badAgreement', 'Each agreed amount must be greater than zero.');
    if (new Set(v.agreements.map((a) => a.trekID)).size !== v.agreements.length) throw new AppError('duplicateTrip', 'The same trip is listed twice.');
    const clash = this.liveList.some((x) => x.id !== v.id && x.service === v.service && x.name.toLowerCase() === v.name.toLowerCase());
    if (clash) throw new AppError('duplicateName', 'A vendor with this name and service already exists.');
    const stamped = stampRecord(v, this.findAny(v.id));
    this.put(stamped);
    return stamped;
  }

  /** Deleting a vendor keeps their past payments in the ledger, which hold a copy of the name. */
  delete(id: Id) { this.removeIds(new Set([id])); }

  search(text: string, service?: ServiceType): Vendor[] {
    const q = text.trim().toLowerCase();
    return this.liveList.filter((v) => {
      if (service !== undefined && v.service !== service) return false;
      if (q === '') return true;
      return v.name.toLowerCase().includes(q) || v.tags.some((t) => t.includes(q)) || v.service.toLowerCase().includes(q) || v.notes.toLowerCase().includes(q);
    });
  }
}

// ------------------------------------------------------------- Guidance

export const MAX_RULES = 20;
export const MAX_RULE_LENGTH = 280;
const MAX_UNDO = 10;

/**
 * Short rules staff have approved ("always mention the pickup point"). They are appended to the system
 * prompt after the base instructions. Every change keeps the previous list so the last change can be undone.
 */
export class GuidanceStore extends RecordStore<GuidanceRule> {
  private undoStack: GuidanceRule[][] = [];

  constructor(kv: KV) { super(kv, 'pahadi.guidance', parseRule); }

  get rules(): GuidanceRule[] { return this.liveList; }
  get canUndo(): boolean { return this.undoStack.length > 0; }

  add(text: string, now = new Date()): GuidanceRule {
    const clean = this.validate(text, undefined);
    if (this.liveList.length >= MAX_RULES) throw new AppError('limitReached', `You can keep up to ${MAX_RULES} rules. Remove one first.`);
    const rule = makeRule(clean, toInstant(now));
    this.commit([...this.liveList, rule]);
    return rule;
  }

  update(id: Id, text: string) {
    const clean = this.validate(text, id);
    this.commit(this.liveList.map((r) => (r.id === id ? { ...r, text: clean } : r)));
  }

  remove(id: Id) { this.commit(this.liveList.filter((r) => r.id !== id)); }

  override clearAll() {
    this.undoStack = [];
    super.clearAll();
  }

  /** Swaps in a whole list (used when restoring a backup). Can be undone like any other change. */
  override replaceAll(list: GuidanceRule[]) { this.commit(list.slice(0, MAX_RULES)); }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    const r = SyncList.replace(this.liveList, this.deletedList, previous, SyncClock.now());
    this.deletedList = r.deleted;
    this.set(r.live);
  }

  /** Takes the merged list from a sync. No stamps change, and undo starts afresh. */
  override applyMerged(all: GuidanceRule[]) {
    const { live, deleted } = SyncList.split(all);
    if (same(live, this.liveList) && same(deleted, this.deletedList)) return;
    this.deletedList = deleted;
    this.undoStack = [];
    this.set(live);
  }

  private validate(text: string, excluding: Id | undefined): string {
    const clean = text.trim();
    if (clean === '') throw new AppError('empty', 'The rule is empty.');
    if (clean.length > MAX_RULE_LENGTH) throw new AppError('tooLong', `Keep a rule under ${MAX_RULE_LENGTH} characters.`);
    if (this.liveList.some((r) => r.id !== excluding && r.text.toLowerCase() === clean.toLowerCase())) throw new AppError('duplicate', 'That rule is already saved.');
    return clean;
  }

  private commit(next: GuidanceRule[]) {
    this.undoStack.push(this.liveList);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    const r = SyncList.replace(this.liveList, this.deletedList, next, SyncClock.now());
    this.deletedList = r.deleted;
    this.set(r.live);
  }
}

