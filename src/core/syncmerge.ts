import { dayKey, ms, type Id } from './ids';
import { decodeLine, parseBooking, parseEntry, parseRule, parseTrek, parseVendor, same } from './codec';
import { changedAt, isDeleted } from './syncrecord';
import type { Booking, GuidanceRule, LedgerEntry, SyncFields, Trek, Vendor } from './models';
import { isCancelled, partySize } from './models';
import { SheetSyncError } from './sheetsync';

/** Every record of every kind, live and deleted. This is what a phone sends and what the sheet holds. */
export interface SyncData {
  treks: Trek[];
  bookings: Booking[];
  ledger: LedgerEntry[];
  vendors: Vendor[];
  guidance: GuidanceRule[];
}

export const emptyData = (): SyncData => ({ treks: [], bookings: [], ledger: [], vendors: [], guidance: [] });
export const recordCount = (d: SyncData) => d.treks.length + d.bookings.length + d.ledger.length + d.vendors.length + d.guidance.length;

/** Seats that were taken beyond what a trek has, found after a merge. */
export interface SeatConflict { trekID: Id; trekName: string; by: number }

export interface SyncReport {
  /** Records that were new or newer in the sheet, so this phone took them. */
  received: number;
  /** Records the sheet lacked or had an older version of, so it takes this phone's. */
  sent: number;
  overbooked: SeatConflict[];
}

/**
 * Merges one kind of record by id. The version changed last wins; records only one side has are kept.
 * A deletion that is as new as an edit wins. Local order is kept, new records follow.
 */
export function mergeRecords<T extends SyncFields>(local: T[], remote: T[]): { merged: T[]; received: number; sent: number } {
  const remoteByID = new Map<Id, T>(remote.map((r) => [r.id, r]));
  const localIDs = new Set<Id>();
  const merged: T[] = [];
  let received = 0, sent = 0;
  for (const l of local) {
    localIDs.add(l.id);
    const r = remoteByID.get(l.id);
    if (!r) { merged.push(l); sent++; continue; }
    if (same(l, r)) { merged.push(l); continue; }
    let takeRemote: boolean;
    if (changedAt(r) !== changedAt(l)) takeRemote = changedAt(r) > changedAt(l);
    else if (isDeleted(r) !== isDeleted(l)) takeRemote = isDeleted(r);
    else takeRemote = false;
    if (takeRemote) { merged.push(r); received++; } else { merged.push(l); sent++; }
  }
  for (const r of remote) {
    if (!localIDs.has(r.id)) { localIDs.add(r.id); merged.push(r); received++; }
  }
  return { merged, received, sent };
}

/** Merges everything, then recomputes seats from the merged bookings. */
export function mergeData(local: SyncData, remote: SyncData): { data: SyncData; report: SyncReport } {
  let received = 0, sent = 0;
  const run = <T extends SyncFields>(l: T[], r: T[]): T[] => {
    const m = mergeRecords(l, r);
    received += m.received;
    sent += m.sent;
    return m.merged;
  };
  const data: SyncData = {
    treks: run(local.treks, remote.treks), bookings: run(local.bookings, remote.bookings),
    ledger: run(local.ledger, remote.ledger), vendors: run(local.vendors, remote.vendors),
    guidance: run(local.guidance, remote.guidance),
  };
  const { treks, conflicts } = reconcileSeats(data.treks, data.bookings);
  return { data: { ...data, treks }, report: { received, sent, overbooked: conflicts } };
}

/**
 * The records of `merged` that the sheet does not hold in this exact form: ones it lacks, or holds an older version of,
 * or whose seats left was recomputed. These are the only records a sync sends.
 */
export function changedFrom(merged: SyncData, remote: SyncData): SyncData {
  const pick = <T extends SyncFields>(m: T[], r: T[]): T[] => {
    const byID = new Map<Id, T>(r.map((x) => [x.id, x]));
    return m.filter((x) => { const o = byID.get(x.id); return o === undefined || !same(x, o); });
  };
  return {
    treks: pick(merged.treks, remote.treks), bookings: pick(merged.bookings, remote.bookings), ledger: pick(merged.ledger, remote.ledger),
    vendors: pick(merged.vendors, remote.vendors), guidance: pick(merged.guidance, remote.guidance),
  };
}

/** Seats taken by bookings that are neither cancelled nor deleted. */
export function seatsBooked(trekID: Id, bookings: Booking[]): number {
  return bookings.filter((b) => b.trekID === trekID && !isCancelled(b) && !isDeleted(b)).reduce((s, b) => s + partySize(b), 0);
}

/**
 * Seats left is always capacity minus the seats of live bookings, so it can be recomputed after a merge.
 * A trek from before capacity existed gets one from its current seats plus what is booked. Bookings beyond
 * capacity leave 0 seats and are reported.
 */
export function reconcileSeats(treks: Trek[], bookings: Booking[]): { treks: Trek[]; conflicts: SeatConflict[] } {
  const taken = new Map<Id, number>();
  for (const b of bookings) if (!isCancelled(b) && !isDeleted(b)) taken.set(b.trekID, (taken.get(b.trekID) ?? 0) + partySize(b));
  const conflicts: SeatConflict[] = [];
  const out = treks.map((t) => {
    if (isDeleted(t) || t.startDate === undefined) return t;
    if (t.seatsLeft === undefined) return t;
    const booked = taken.get(t.id) ?? 0;
    const capacity = t.seatCapacity ?? t.seatsLeft + booked;
    if (booked > capacity) {
      conflicts.push({ trekID: t.id, trekName: t.name, by: booked - capacity });
      return { ...t, seatCapacity: capacity, seatsLeft: 0 };
    }
    return { ...t, seatCapacity: capacity, seatsLeft: capacity - booked };
  });
  return { treks: out, conflicts };
}

// -------------------------------------------------------------- Duplicates

/** Entries that look like the same payment typed twice on different phones. */
export interface DuplicateGroup {
  entries: LedgerEntry[];
  /** Stable for this exact set of entries, so "keep both" stays dismissed until another lookalike appears. */
  id: string;
}

/** Live entries with the same type, amount, day, trip and traveller or vendor but different ids. */
export function duplicateGroups(entries: LedgerEntry[], dismissed: Set<string> = new Set()): DuplicateGroup[] {
  const buckets = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (isDeleted(e)) continue;
    const who = (e.bookingID ?? e.vendorID ?? '').toUpperCase();
    const trek = (e.shares[0]?.trekID ?? '').toUpperCase();
    const key = `${e.kind}|${e.amount}|${dayKey(e.date)}|${who}|${trek}`;
    const list = buckets.get(key);
    if (list) list.push(e); else buckets.set(key, [e]);
  }
  const groups: DuplicateGroup[] = [];
  for (const g of buckets.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || cmp(a.id.toUpperCase(), b.id.toUpperCase()));
    const id = sorted.map((e) => e.id.toUpperCase()).sort().join('|');
    if (!dismissed.has(id)) groups.push({ entries: sorted, id });
  }
  return groups.sort((a, b) => ms(b.entries[0].date) - ms(a.entries[0].date) || cmp(b.id, a.id));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------ Reading a pull

/**
 * Reads what a pull returned. Any row this app cannot read stops the sync, because writing the merged result
 * back would erase that row from the sheet.
 */
export function decodeTables(tables: Record<string, string[]>): SyncData {
  let unreadable = 0;
  const read = <T extends SyncFields>(name: string, parse: (o: unknown) => T | null): T[] => {
    const seen = new Set<Id>();
    const out: T[] = [];
    for (const line of tables[name] ?? []) {
      const r = decodeLine(parse, line);
      if (r === null) unreadable++;
      else if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
    return out;
  };
  const data: SyncData = {
    treks: read('Treks', parseTrek), bookings: read('Bookings', parseBooking), ledger: read('Money', parseEntry),
    vendors: read('Vendors', parseVendor), guidance: read('Guidance', parseRule),
  };
  if (unreadable > 0) throw new SheetSyncError('unreadableRows', { count: unreadable });
  return data;
}
